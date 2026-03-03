const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fetch = require("node-fetch");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("public"));

const rooms = {};
const QUESTION_TIME = 10000;
const RESULT_DELAY = 1500;

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

async function preloadQuestions(amount, difficulty, category) {
  let url = `https://opentdb.com/api.php?amount=${amount}&type=multiple&difficulty=${difficulty}`;
  if (category !== "mix") url += `&category=${category}`;

  const res = await fetch(url);
  const data = await res.json();
  if (!data.results) return [];

  return data.results.map(q => ({
    text: q.question,
    options: shuffle([...q.incorrect_answers, q.correct_answer]),
    correct: q.correct_answer
  }));
}

function emitLeaderboard(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const sorted = Object.values(room.players).sort((a,b)=>{
    if (b.score !== a.score) return b.score - a.score;
    return a.totalTime - b.totalTime;
  });

  io.to(roomId).emit("leaderboard-update", sorted);
}

io.on("connection",(socket)=>{

  socket.on("create-room", async(data)=>{
    const { name, maxQuestions, difficulty, category, avatar, powerUps } = data;

    let roomCode;
    do { roomCode = generateCode(); } while(rooms[roomCode]);

    const questions = await preloadQuestions(maxQuestions, difficulty, category);

    rooms[roomCode] = {
      host: socket.id,
      questions,
      current: 0,
      players: {},
      answered: {},
      started: false,
      timer: null,
      startTime: 0,
      maxPlayers: 6,
      powerUpsEnabled: powerUps === true
    };

    rooms[roomCode].players[socket.id] = {
      name,
      avatar,
      score: 0,
      totalTime: 0,
      used5050: false
    };

    socket.join(roomCode);
    socket.roomId = roomCode;

    socket.emit("room-joined",{roomCode,isHost:true});
    io.to(roomCode).emit("lobby-update",Object.values(rooms[roomCode].players));
  });

  socket.on("join-room",(data)=>{
    const room = rooms[data.roomCode];
    if (!room) return socket.emit("error","Invalid Room Code");
    if (room.started) return socket.emit("error","Game already started");
    if (Object.keys(room.players).length >= room.maxPlayers)
      return socket.emit("error","Room Full");

    room.players[socket.id] = {
      name:data.name,
      avatar:data.avatar,
      score:0,
      totalTime:0,
      used5050:false
    };

    socket.join(data.roomCode);
    socket.roomId = data.roomCode;

    socket.emit("room-joined",{roomCode:data.roomCode,isHost:false});
    io.to(data.roomCode).emit("lobby-update",Object.values(room.players));
  });

  socket.on("start-game",()=>{
    const room = rooms[socket.roomId];
    if (!room) return;
    if (room.host !== socket.id) return;

    room.started = true;
    sendQuestion(socket.roomId);
  });

  function sendQuestion(roomId){
    const room = rooms[roomId];
    if (!room) return;

    if (room.current >= room.questions.length) {
      return endGame(roomId);
    }

    room.answered = {};
    room.startTime = Date.now();

    io.to(roomId).emit("new-question",{
      q:room.questions[room.current],
      qNum:room.current+1,
      max:room.questions.length,
      time:QUESTION_TIME,
      powerUpsEnabled:room.powerUpsEnabled
    });

    room.timer = setTimeout(()=>reveal(roomId),QUESTION_TIME);
  }

  socket.on("use-5050",()=>{
    const room = rooms[socket.roomId];
    if (!room) return;
    if (!room.powerUpsEnabled) return;

    const player = room.players[socket.id];
    if (!player || player.used5050) return;

    player.used5050 = true;

    const question = room.questions[room.current];
    const wrong = question.options.filter(o=>o!==question.correct);
    const removed = shuffle(wrong).slice(0,2);

    socket.emit("apply-5050", removed);
  });

  socket.on("submit-answer",(answer)=>{
    const room = rooms[socket.roomId];
    if (!room || room.answered[socket.id]) return;

    room.answered[socket.id]=true;
    const player = room.players[socket.id];
    const timeTaken = Date.now()-room.startTime;

    if (answer===room.questions[room.current].correct) player.score++;
    player.totalTime+=timeTaken;

    socket.emit("result",{correct:answer===room.questions[room.current].correct});
    emitLeaderboard(socket.roomId);

    if (Object.keys(room.answered).length===Object.keys(room.players).length){
      reveal(socket.roomId);
    }
  });

  function reveal(roomId){
    const room = rooms[roomId];
    if (!room) return;

    clearTimeout(room.timer);

    io.to(roomId).emit("reveal-answer",room.questions[room.current].correct);
    emitLeaderboard(roomId);

    setTimeout(()=>{
      room.current++;
      sendQuestion(roomId);
    },RESULT_DELAY);
  }

  function endGame(roomId){
    const room = rooms[roomId];
    if (!room) return;

    const players = Object.values(room.players).sort((a,b)=>{
      if (b.score!==a.score) return b.score-a.score;
      return a.totalTime-b.totalTime;
    });

    io.to(roomId).emit("game-over",players);
    delete rooms[roomId];
  }

});

const PORT = process.env.PORT||3000;
server.listen(PORT,()=>console.log("Server running on port "+PORT));

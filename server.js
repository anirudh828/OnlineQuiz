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

async function preloadQuestions(amount = 5, difficulty = "easy", category = "mix") {
  try {
    let url = `https://opentdb.com/api.php?amount=${amount}&type=multiple&difficulty=${difficulty}`;

    if (category !== "mix") {
      url += `&category=${category}`;
    }

    const res = await fetch(url);
    const data = await res.json();

    if (!data.results) return [];

    return data.results.map(q => {
      const options = shuffle([...q.incorrect_answers, q.correct_answer]);
      return {
        text: q.question,
        options,
        correct: q.correct_answer
      };
    });

  } catch {
    return [];
  }
}

function emitLeaderboard(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const sorted = Object.values(room.players).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.totalTime - b.totalTime;
  });

  io.to(roomId).emit("leaderboard-update", sorted);
}

io.on("connection", (socket) => {

  socket.on("create-room", async (data) => {
    const name = data.name;
    const maxQuestions = parseInt(data.maxQuestions) || 5;
    const difficulty = data.difficulty || "easy";
    const category = data.category || "mix";
    const avatar = data.avatar || "😎";

    let roomCode;
    do { roomCode = generateCode(); }
    while (rooms[roomCode]);

    const questions = await preloadQuestions(maxQuestions, difficulty, category);

    rooms[roomCode] = {
      host: socket.id,
      questions,
      current: 0,
      players: {},
      answered: {},
      timer: null,
      startTime: 0,
      maxPlayers: 6
    };

    rooms[roomCode].players[socket.id] = {
      name,
      avatar,
      score: 0,
      totalTime: 0
    };

    socket.join(roomCode);
    socket.roomId = roomCode;

    socket.emit("room-joined", { roomCode, isHost: true });

    io.to(roomCode).emit("lobby-update",
      Object.values(rooms[roomCode].players)
    );
  });

  socket.on("join-room", (data) => {
    const room = rooms[data.roomCode];
    if (!room) return socket.emit("error", "Invalid Room Code");

    if (Object.keys(room.players).length >= room.maxPlayers) {
      return socket.emit("error", "Room Full");
    }

    room.players[socket.id] = {
      name: data.name,
      avatar: data.avatar || "😎",
      score: 0,
      totalTime: 0
    };

    socket.join(data.roomCode);
    socket.roomId = data.roomCode;

    socket.emit("room-joined", {
      roomCode: data.roomCode,
      isHost: false
    });

    io.to(data.roomCode).emit("lobby-update",
      Object.values(room.players)
    );
  });

  socket.on("start-game", () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (room.host !== socket.id) return;
    sendQuestion(socket.roomId);
  });

  function sendQuestion(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.current >= room.questions.length) {
      return endGame(roomId);
    }

    clearTimeout(room.timer);
    room.answered = {};
    room.startTime = Date.now();

    const q = room.questions[room.current];

    io.to(roomId).emit("new-question", {
      q,
      qNum: room.current + 1,
      max: room.questions.length
    });

    room.timer = setTimeout(() => {
      reveal(roomId);
    }, QUESTION_TIME);
  }

  socket.on("submit-answer", (answer) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (room.answered[socket.id]) return;

    room.answered[socket.id] = true;

    const player = room.players[socket.id];
    const timeTaken = Date.now() - room.startTime;

    if (answer === room.questions[room.current].correct) {
      player.score++;
    }

    player.totalTime += timeTaken;

    socket.emit("result", {
      correct: answer === room.questions[room.current].correct
    });

    emitLeaderboard(socket.roomId);

    if (Object.keys(room.answered).length >= Object.keys(room.players).length) {
      reveal(socket.roomId);
    }
  });

  function reveal(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    clearTimeout(room.timer);

    io.to(roomId).emit(
      "reveal-answer",
      room.questions[room.current].correct
    );

    emitLeaderboard(roomId);

    setTimeout(() => {
      room.current++;
      sendQuestion(roomId);
    }, RESULT_DELAY);
  }

  function endGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const players = Object.values(room.players).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.totalTime - b.totalTime;
    });

    io.to(roomId).emit("game-over", players);
    delete rooms[roomId];
  }

  socket.on("disconnect", () => {
    const room = rooms[socket.roomId];
    if (!room) return;

    delete room.players[socket.id];

    if (Object.keys(room.players).length === 0) {
      clearTimeout(room.timer);
      delete rooms[socket.roomId];
      return;
    }

    io.to(socket.roomId).emit("lobby-update",
      Object.values(room.players)
    );
  });

});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

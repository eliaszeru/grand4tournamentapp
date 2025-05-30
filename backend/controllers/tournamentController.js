const Tournament = require("../models/Tournament");
const Match = require("../models/Match");
const User = require("../models/User");
const nodemailer = require("nodemailer");
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// @desc    Create new tournament
// @route   POST /api/tournaments
// @access  Private (Admin only)
exports.createTournament = async (req, res) => {
  try {
    const { name, playerIds, startDate, matchTime } = req.body;
    if (!playerIds || playerIds.length < 2 || playerIds.length > 8) {
      return res.status(400).json({ message: "Select 2, 4, or 8 players." });
    }
    // Shuffle and pair players
    const shuffled = shuffle([...playerIds]);
    const matches = [];
    for (let i = 0; i < shuffled.length; i += 2) {
      if (shuffled[i + 1]) {
        matches.push({
          player1: shuffled[i],
          player2: shuffled[i + 1],
          scheduledTime: matchTime || startDate,
        });
      }
    }
    const tournament = await Tournament.create({
      name,
      admin: req.user._id,
      players: playerIds,
      bracket: matches,
      status: "active",
      startDate,
      maxPlayers: playerIds.length,
    });
    // Send email notifications to players about their first round match
    for (const match of matches) {
      const [player1, player2] = await Promise.all([
        User.findById(match.player1),
        User.findById(match.player2),
      ]);
      const dateStr = new Date(match.scheduledTime).toLocaleString();
      const subject = `Tournament Match Scheduled: ${name}`;
      const text1 = `Hello ${player1.username},\n\nYou have a tournament match scheduled!\nOpponent: ${player2.username}\nDate & Time: ${dateStr}\n\nGood luck!`;
      const text2 = `Hello ${player2.username},\n\nYou have a tournament match scheduled!\nOpponent: ${player1.username}\nDate & Time: ${dateStr}\n\nGood luck!`;
      await sendEmail(player1.email, subject, text1);
      await sendEmail(player2.email, subject, text2);
    }
    res.status(201).json(tournament);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Get all tournaments
// @route   GET /api/tournaments
// @access  Public
exports.getTournaments = async (req, res) => {
  try {
    const tournaments = await Tournament.find({ status: { $ne: "ended" } })
      .populate("players", "username email")
      .populate(
        "bracket.player1 bracket.player2 bracket.result.winner",
        "username email"
      );
    res.json(tournaments);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Get tournament by ID
// @route   GET /api/tournaments/:id
// @access  Public
exports.getTournamentById = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate("admin", "username email")
      .populate("players", "username email");

    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    res.json(tournament);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Join tournament
// @route   POST /api/tournaments/:id/join
// @access  Private
exports.joinTournament = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    if (tournament.players.length >= tournament.maxPlayers) {
      return res.status(400).json({ message: "Tournament is full" });
    }

    if (tournament.players.includes(req.user._id)) {
      return res
        .status(400)
        .json({ message: "Already joined this tournament" });
    }

    tournament.players.push(req.user._id);
    await tournament.save();

    // If we have 8 players, start the tournament
    if (tournament.players.length === 8) {
      await startTournament(tournament._id);
    }

    res.json(tournament);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// Helper function to start tournament and create first round matches
async function startTournament(tournamentId) {
  try {
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) return;

    // Shuffle players array for random matchups
    const players = [...tournament.players];
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [players[i], players[j]] = [players[j], players[i]];
    }

    // Create matches for first round
    for (let i = 0; i < players.length; i += 2) {
      await Match.create({
        tournament: tournamentId,
        round: 1,
        player1: players[i],
        player2: players[i + 1],
      });
    }

    tournament.status = "active";
    tournament.currentRound = 1;
    await tournament.save();
  } catch (error) {
    console.error("Error starting tournament:", error);
  }
}

// Admin: End tournament
exports.endTournament = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament)
      return res.status(404).json({ message: "Tournament not found" });
    tournament.status = "ended";
    tournament.endedAt = new Date();
    await tournament.save();
    res.json({ message: "Tournament ended" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// Player: Submit match result
exports.submitResult = async (req, res) => {
  try {
    const { matchId, score, winnerId } = req.body;
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament)
      return res.status(404).json({ message: "Tournament not found" });
    const match = tournament.bracket.id(matchId);
    if (!match) return res.status(404).json({ message: "Match not found" });
    match.result = {
      score,
      winner: winnerId,
      approved: false,
      submittedBy: req.user._id,
    };
    match.status = "pending";
    await tournament.save();
    res.json({ message: "Result submitted, waiting for admin approval." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// Admin: Approve match result
exports.approveResult = async (req, res) => {
  try {
    const { matchId } = req.body;
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament)
      return res.status(404).json({ message: "Tournament not found" });
    const match = tournament.bracket.id(matchId);
    if (!match) return res.status(404).json({ message: "Match not found" });
    match.result.approved = true;
    match.status = "completed";
    await tournament.save();
    res.json({ message: "Result approved." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// Get previous results (user view)
exports.getPreviousResults = async (req, res) => {
  try {
    const tournaments = await Tournament.find({ status: "ended" })
      .populate("players", "username email")
      .populate(
        "bracket.player1 bracket.player2 bracket.result.winner",
        "username email"
      );
    res.json(tournaments);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Get tournaments for the logged-in player
// @route   GET /api/player/tournaments
// @access  Private
exports.getPlayerTournaments = async (req, res) => {
  try {
    const tournaments = await Tournament.find({
      players: req.user._id,
      status: { $ne: "ended" },
    })
      .populate("players", "username email")
      .populate(
        "bracket.player1 bracket.player2 bracket.result.winner",
        "username email"
      );
    res.json(tournaments);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// Helper: shuffle array
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// @desc    Get all pending match results for admin approval
// @route   GET /api/tournaments/pending-results
// @access  Private (Admin only)
exports.getPendingResults = async (req, res) => {
  try {
    const tournaments = await Tournament.find({
      status: { $in: ["active", "pending"] },
    })
      .populate("bracket.player1", "username email")
      .populate("bracket.player2", "username email");
    const pendingResults = [];
    tournaments.forEach((tournament) => {
      tournament.bracket.forEach((match) => {
        if (
          match.result &&
          match.result.score &&
          !match.result.approved &&
          match.status === "pending"
        ) {
          pendingResults.push({
            tournamentId: tournament._id,
            tournamentName: tournament.name,
            matchId: match._id,
            player1Name: match.player1.username || match.player1.email,
            player2Name: match.player2.username || match.player2.email,
            score: match.result.score,
          });
        }
      });
    });
    res.json(pendingResults);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Continue tournament to next round (manual winner selection)
// @route   POST /api/tournaments/:id/continue
// @access  Private (Admin only)
exports.continueTournament = async (req, res) => {
  try {
    const { nextRoundTime, selectedWinners } = req.body;
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament)
      return res.status(404).json({ message: "Tournament not found" });
    if (tournament.status !== "active")
      return res.status(400).json({ message: "Tournament is not active" });

    const currentRound = tournament.currentRound || 1;
    // Get matches for current round
    const currentMatches = tournament.bracket.filter(
      (m) => m.round === currentRound
    );
    if (!currentMatches.length)
      return res.status(400).json({ message: "No matches in current round" });
    // Check if all matches are completed
    if (!currentMatches.every((m) => m.status === "completed")) {
      return res
        .status(400)
        .json({ message: "Not all matches in current round are completed" });
    }
    // Validate selectedWinners
    if (!Array.isArray(selectedWinners)) {
      return res
        .status(400)
        .json({ message: "selectedWinners must be an array" });
    }
    const expectedCount = currentMatches.length / 2;
    if (
      selectedWinners.length !== expectedCount &&
      selectedWinners.length !== 1
    ) {
      return res.status(400).json({
        message: `You must select exactly ${expectedCount} players to advance, or 1 to finish the tournament.`,
      });
    }
    // If only one winner, end the tournament and set champion
    if (selectedWinners.length === 1) {
      tournament.status = "ended";
      tournament.endedAt = new Date();
      tournament.champion = selectedWinners[0];
      await tournament.save();
      return res.json({
        message: "Tournament ended",
        champion: selectedWinners[0],
        tournament,
      });
    }
    // Shuffle selected winners for next round pairings
    for (let i = selectedWinners.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [selectedWinners[i], selectedWinners[j]] = [
        selectedWinners[j],
        selectedWinners[i],
      ];
    }
    // Create next round matches
    const nextRound = currentRound + 1;
    const newMatches = [];
    for (let i = 0; i < selectedWinners.length; i += 2) {
      if (selectedWinners[i + 1]) {
        const match = {
          player1: selectedWinners[i],
          player2: selectedWinners[i + 1],
          scheduledTime: nextRoundTime,
          round: nextRound,
          status: "pending",
        };
        tournament.bracket.push(match);
        newMatches.push(match);
      }
    }
    tournament.currentRound = nextRound;
    await tournament.save();
    // Send email notifications to players about their next round match
    for (const match of newMatches) {
      const [player1, player2] = await Promise.all([
        User.findById(match.player1),
        User.findById(match.player2),
      ]);
      const dateStr = new Date(match.scheduledTime).toLocaleString();
      const subject = `Tournament Next Round: ${tournament.name}`;
      const text1 = `Hello ${player1.username},\n\nYou have advanced to the next round!\nOpponent: ${player2.username}\nDate & Time: ${dateStr}\n\nGood luck!`;
      const text2 = `Hello ${player2.username},\n\nYou have advanced to the next round!\nOpponent: ${player1.username}\nDate & Time: ${dateStr}\n\nGood luck!`;
      await sendEmail(player1.email, subject, text1);
      await sendEmail(player2.email, subject, text2);
    }
    res.json(tournament);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// Helper function to send emails
async function sendEmail(to, subject, text) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text,
    });
  } catch (error) {
    console.error("Error sending email:", error);
  }
}

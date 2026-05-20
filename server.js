const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

// ── Servir le client HTML ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── État du monde (partagé entre tous les joueurs) ───────────────────────────
const ZONE_ID = 'archives-occultes'; // une seule zone pour l'instant

const world = {
  players: {},   // socketId → PlayerState
  npcs: {
    goule: { id:'goule', name:'Goule des Archives', row:6, col:6,
             hp:220, hpMax:220, alive:true },
    rook:  { id:'rook',  name:'Rook', row:7, col:8,
             hp:340, hpMax:340, avatar:'https://i.imgur.com/UNxEEdQ.jpeg' }
  },
  combat: null,  // null | CombatState
  fog:    false,
  sanctuary: null, // null | {r,c,placedBy}
  effects: {},  // playerId → [effects]
};

// MAP partagée (même que côté client)
const MAP = [
  "wwwwwwwwwwwwww",
  "wffffffffffffw",
  "wfDDDDDDDDfffw",
  "wfDDDDDDDDfffw",
  "wfDDDDDDDDfffw",
  "wffffffffffffw",
  "wff.ssEsss.ffw",
  "wff.ssssRs.ffw",
  "wff.ssssss.ffw",
  "wfffffdffffffw",
  "wf.f..f...f.fw",
  "wfffffpffffffw",
  "wwwwwwwwwwwwww"
];

function walkable(ch){ return 'fs.d'.includes(ch); }

// ── Helpers ──────────────────────────────────────────────────────────────────
function broadcastWorldState(room) {
  io.to(room).emit('world:state', {
    players:   world.players,
    npcs:      world.npcs,
    combat:    world.combat,
    fog:       world.fog,
    sanctuary: world.sanctuary,
  });
}

function getRoom(r, c) {
  if (r <= 4) return "Salle des Stèles";
  if (r >= 6 && r <= 8 && c >= 3 && c <= 9) return "Salle de Lecture";
  if (r >= 9) return "Archives Occultes";
  return "Couloir Meridian";
}

// ── Connexion ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Joueur connecté : ${socket.id}`);

  // ── Rejoindre la zone ──────────────────────────────────────────────────────
  socket.on('player:join', (data) => {
    // data: { name, avatar, charClass, maison }
    const player = {
      id:       socket.id,
      name:     data.name     || 'Anonyme',
      avatar:   data.avatar   || null,
      maison:   data.maison   || 'The Meridian',
      row: 11, col: 6,
      hp: 480,  hpMax: 480,
      mana: 80, manaMax: 80,
      effects: [],
      buildSlots: { passif: null, actif: [null,null,null], ultime: null },
    };
    world.players[socket.id] = player;
    socket.join(ZONE_ID);

    // Envoyer l'état complet au nouveau joueur
    socket.emit('world:state', {
      players: world.players, npcs: world.npcs,
      combat: world.combat, fog: world.fog, sanctuary: world.sanctuary,
      map: MAP,
      myId: socket.id,
    });

    // Notifier les autres
    socket.to(ZONE_ID).emit('chat:system',
      `✦ ${player.name} rejoint ${getRoom(player.row, player.col)}.`);
    socket.to(ZONE_ID).emit('player:joined', player);
    console.log(`  ${player.name} rejoint la zone`);
  });

  // ── Déplacement ───────────────────────────────────────────────────────────
  socket.on('player:move', (data) => {
    // data: { row, col }
    const player = world.players[socket.id];
    if (!player) return;
    const ch = (MAP[data.row] || '')[data.col] || 'w';
    if (!walkable(ch)) return;
    const dist = Math.abs(data.row - player.row) + Math.abs(data.col - player.col);
    const maxMove = world.fog ? 2 : 3;
    if (dist === 0 || dist > maxMove) return;

    player.row = data.row;
    player.col = data.col;
    const room = getRoom(data.row, data.col);

    io.to(ZONE_ID).emit('player:moved', {
      id: socket.id, name: player.name,
      row: data.row, col: data.col, room
    });
  });

  // ── Chat ──────────────────────────────────────────────────────────────────
  socket.on('chat:message', (data) => {
    // data: { text, mode, isEmote }
    const player = world.players[socket.id];
    if (!player) return;
    io.to(ZONE_ID).emit('chat:message', {
      senderId:   socket.id,
      senderName: player.name,
      senderAvatar: player.avatar,
      text:  data.text,
      mode:  data.mode  || 'normal',
      isEmote: data.isEmote || false,
    });
  });

  // ── Combat ────────────────────────────────────────────────────────────────
  socket.on('combat:start', (data) => {
    // data: { targetId } — 'goule' ou socketId d'un joueur
    const player = world.players[socket.id];
    if (!player || world.combat) return;

    let enemy;
    if (data.targetId === 'goule' && world.npcs.goule.alive) {
      enemy = { ...world.npcs.goule, side: 'attacker' };
    } else if (world.players[data.targetId]) {
      enemy = { ...world.players[data.targetId], side: 'attacker' };
    } else return;

    world.combat = {
      id: uuidv4(),
      defenders: [{ id: socket.id, name: player.name, avatar: player.avatar,
                    hp: player.hp, hpMax: player.hpMax,
                    mana: player.mana, manaMax: player.manaMax }],
      attackers:  [{ id: enemy.id, name: enemy.name, avatar: enemy.avatar||null,
                     hp: enemy.hp, hpMax: enemy.hpMax }],
      turn: socket.id,  // joueur qui attaque en premier
      turnCount: 1,
      log: [],
    };

    io.to(ZONE_ID).emit('combat:started', {
      combat: world.combat,
      initiator: socket.id,
    });
    console.log(`  Combat started by ${player.name} vs ${enemy.name}`);
  });

  socket.on('combat:action', (data) => {
    // data: { type, sortId, targetId }
    if (!world.combat) return;
    if (world.combat.turn !== socket.id) return;
    const player = world.players[socket.id];
    if (!player) return;

    let logEntry = '';
    let dmg = 0;

    if (data.type === 'basic') {
      dmg = Math.max(1, 8 + Math.floor(Math.random() * 10));
      const crit = Math.random() < 0.15;
      if (crit) dmg = Math.floor(dmg * 1.6);
      logEntry = `${player.name} attaque${crit?' (CRITIQUE)':''} — ${dmg} dégâts.`;
      // Appliquer aux attaquants (premier attaquant = cible par défaut)
      if (world.combat.attackers[0]) {
        world.combat.attackers[0].hp = Math.max(0, world.combat.attackers[0].hp - dmg);
        // Mettre à jour le NPC si c'est la goule
        if (world.combat.attackers[0].id === 'goule') {
          world.npcs.goule.hp = world.combat.attackers[0].hp;
        }
      }
    } else if (data.type === 'flee') {
      const success = Math.random() < 0.6;
      logEntry = success ? `${player.name} prend la fuite !` : `${player.name} ne peut pas fuir !`;
      if (success) {
        const prevCombat = world.combat;
        world.combat = null;
        io.to(ZONE_ID).emit('combat:ended', { reason: 'flee', by: socket.id });
        io.to(ZONE_ID).emit('chat:system', logEntry);
        return;
      }
    }

    world.combat.log.push({ by: socket.id, name: player.name, text: logEntry });
    // Passer au tour suivant (simplifié : alterner)
    world.combat.turn = world.combat.attackers[0]?.id || socket.id;
    world.combat.turnCount++;

    // Vérifier victoire
    const allDead = world.combat.attackers.every(a => a.hp <= 0);
    if (allDead) {
      if (world.combat.attackers[0]?.id === 'goule') {
        world.npcs.goule.alive = false;
      }
      io.to(ZONE_ID).emit('combat:ended', { reason: 'victory', winner: socket.id });
      io.to(ZONE_ID).emit('chat:system', `✦ ${player.name} remporte le combat !`);
      world.combat = null;
    } else {
      io.to(ZONE_ID).emit('combat:action', {
        combat: world.combat,
        logEntry, dmg,
        actorId: socket.id,
      });
      // Tour ennemi NPC auto si c'est la goule
      if (world.combat && world.combat.turn === 'goule') {
        setTimeout(() => npcTurn(), 1200);
      }
    }
  });

  socket.on('combat:join', (data) => {
    // data: { side: 'def'|'att' }
    if (!world.combat) return;
    const player = world.players[socket.id];
    if (!player) return;
    const entry = { id: socket.id, name: player.name, avatar: player.avatar,
                    hp: player.hp, hpMax: player.hpMax };
    if (data.side === 'def') world.combat.defenders.push(entry);
    else world.combat.attackers.push(entry);
    io.to(ZONE_ID).emit('combat:updated', { combat: world.combat });
    io.to(ZONE_ID).emit('chat:system', `${player.name} rejoint les ${data.side==='def'?'défenseurs':'attaquants'} !`);
  });

  // ── Sorts de map ──────────────────────────────────────────────────────────
  socket.on('map:fog', (data) => {
    // data: { active }
    const player = world.players[socket.id];
    if (!player) return;
    world.fog = data.active;
    io.to(ZONE_ID).emit('map:fog', { active: data.active, by: socket.id, name: player.name });
    io.to(ZONE_ID).emit('chat:system',
      data.active
        ? `🌫 ${player.name} invoque un Voile de Brume.`
        : `🌫 Le Voile de Brume se dissipe.`
    );
  });

  socket.on('map:sanctuary', (data) => {
    // data: { active, row, col }
    const player = world.players[socket.id];
    if (!player) return;
    if (data.active) {
      world.sanctuary = { r: data.row, c: data.col, placedBy: player.name };
    } else {
      world.sanctuary = null;
    }
    io.to(ZONE_ID).emit('map:sanctuary', {
      active: data.active, row: data.row, col: data.col,
      by: socket.id, name: player.name
    });
  });

  // ── Repos / soin ──────────────────────────────────────────────────────────
  socket.on('player:regen', (data) => {
    // data: { type:'mana'|'hp', val }
    const player = world.players[socket.id];
    if (!player) return;
    if (data.type === 'mana') player.mana = Math.min(player.manaMax, player.mana + data.val);
    if (data.type === 'hp')   player.hp   = Math.min(player.hpMax,   player.hp   + data.val);
    io.to(ZONE_ID).emit('player:updated', { id: socket.id, hp: player.hp, mana: player.mana });
  });

  // ── Déconnexion ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const player = world.players[socket.id];
    if (player) {
      console.log(`[-] ${player.name} déconnecté`);
      io.to(ZONE_ID).emit('chat:system', `${player.name} a quitté la zone.`);
      io.to(ZONE_ID).emit('player:left', { id: socket.id });
      delete world.players[socket.id];
    }
  });
});

// ── Tour NPC (Goule) ──────────────────────────────────────────────────────────
function npcTurn() {
  if (!world.combat) return;
  const moves = [
    { name:'Morsure', dmg:18 },
    { name:'Cri Spectral', dmg:12 },
    { name:'Drain de Vie', dmg:22 },
  ];
  const move = moves[Math.floor(Math.random() * moves.length)];
  const defender = world.combat.defenders[0];
  if (!defender) return;
  const dmg = Math.max(1, move.dmg + Math.floor(Math.random()*6) - 3);
  defender.hp = Math.max(0, defender.hp - dmg);
  // Mettre à jour le joueur
  if (world.players[defender.id]) world.players[defender.id].hp = defender.hp;

  const logEntry = `☠ ${move.name} sur ${defender.name} — ${dmg} dégâts.`;
  world.combat.log.push({ by: 'goule', name: 'Goule', text: logEntry });
  world.combat.turn = defender.id;
  world.combat.turnCount++;

  if (defender.hp <= 0) {
    io.to(ZONE_ID).emit('combat:ended', { reason: 'defeat', loserId: defender.id });
    io.to(ZONE_ID).emit('chat:system', `☠ ${defender.name} est mis hors combat.`);
    world.combat = null;
  } else {
    io.to(ZONE_ID).emit('combat:action', {
      combat: world.combat, logEntry, dmg,
      actorId: 'goule',
    });
  }
}

// ── Lancer le serveur ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🏰 Anathème Server running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}\n`);
});

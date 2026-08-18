// =================================================================
// GAME_MANAGER.JS (Cérebro do Jogo Multiplayer - Sincronizado, Compactado e Sessões)
// =================================================================

const { Monstro, configPadrao, getHordeConfig } = require('./monstro.js');

const gameState = {
    isGameRunning: false,
    isPaused: false,
    sharedLife: 1000,
    sharedLifeMax: 1000,
    level: 1,
    xp: 0,
    xpMax: 100,
    currentHorde: 0,
    sharedRaioCenarioReduction: 0 
};

let serverPlayers = {};
let serverMonsters = [];
let monsterStock = []; 
let pendingRuneChoicesCount = {}; // Memória contadora de escolhas por jogador
let isLevelUpLock = false; 

let playerTokens = {}; // Guarda o token de reconexão de cada slot (1 ou 2)
let playerDisconnectTime = {}; // Guarda o timestamp da desconexão
let serverConnections = {}; // Referência para os sockets ativos de server.js
let playerLevel = {}; // Guarda o nível em que cada jogador desconectou

// Sistema de Reciclagem de IDs (IDs de m1 a m30)
let availableMonsterIds = [];
for (let i = 1; i <= 30; i++) {
    availableMonsterIds.push(`m${i}`);
}

function getNextMonsterId() {
    if (availableMonsterIds.length > 0) {
        return availableMonsterIds.shift();
    }
    return `m_${Date.now()}_${Math.random()}`; 
}

function recycleMonsterId(id) {
    if (id.startsWith('m') && !id.includes('_')) {
        if (!availableMonsterIds.includes(id)) {
            availableMonsterIds.push(id);
            availableMonsterIds.sort((a, b) => {
                const numA = parseInt(a.replace('m', ''));
                const numB = parseInt(b.replace('m', ''));
                return numA - numB;
            });
        }
    }
}

// Mapeamento numérico dos sprites de monstros para compactar payload
function getSpriteCode(sprite) {
    if (sprite === '1a.png') return 1;
    if (sprite === '1b.png') return 2;
    if (sprite === '2a.png') return 3;
    if (sprite === '2b.png') return 4;
    return 1;
}

let gameLoopInterval = null;
const GAME_TICK_RATE = 30;
const GAME_INTERVAL = 1000 / GAME_TICK_RATE;
const SCENARIO_WIDTH = 2176;
const SCENARIO_HEIGHT = 1057;
const MAX_ON_SCREEN_MONSTERS = 14; 

function spawnServerMonster(tipo, config) {
    const spawnMinX = 200;
    const spawnMaxX = SCENARIO_WIDTH - 200;
    const x = Math.random() * (spawnMaxX - spawnMinX) + spawnMinX;
    const y = - (config.height || 64) - Math.random() * 100;
    const minY = config.minY ?? SCENARIO_HEIGHT * 0.2;
    const maxY = config.maxY ?? SCENARIO_HEIGHT * 0.9;
    const targetY = Math.random() * (maxY - minY) + minY;
    
    const newMonster = new Monstro(config.spriteNormal, {
        ...config,
        id: getNextMonsterId(), 
        x, y, targetY, hasLanded: false
    });
    newMonster.tipo = tipo;
    serverMonsters.push(newMonster);
    return newMonster;
}

function balanceMonsterTargets(players) {
    if (players.length < 2) return;

    const player1 = players.find(p => p.id === 1);
    const player2 = players.find(p => p.id === 2);

    if (!player1 || !player2) return;

    let p1Targets = [];
    let p2Targets = [];

    serverMonsters.forEach(m => {
        if (m.currentTarget === player1) p1Targets.push(m);
        else if (m.currentTarget === player2) p2Targets.push(m);
    });

    const totalMonsters = serverMonsters.length;
    if (totalMonsters < 4) return;

    const imbalanceThreshold = 0.70;
    const rebalancePercentage = 0.25;

    let overloadedPlayer, freePlayer, overloadedMonsters;

    if (p1Targets.length / totalMonsters > imbalanceThreshold) {
        overloadedPlayer = player1;
        freePlayer = player2;
        overloadedMonsters = p1Targets;
    } else if (p2Targets.length / totalMonsters > imbalanceThreshold) {
        overloadedPlayer = player2;
        freePlayer = player1;
        overloadedMonsters = p2Targets;
    } else {
        return;
    }

    const monstersToReassignCount = Math.ceil(overloadedMonsters.length * rebalancePercentage);

    overloadedMonsters.sort((a, b) => {
        const distA = Math.hypot(a.x - freePlayer.x, a.y - freePlayer.y);
        const distB = Math.hypot(b.x - freePlayer.x, b.y - freePlayer.y);
        return distA - distB;
    });

    for (let i = 0; i < monstersToReassignCount; i++) {
        if (overloadedMonsters[i]) {
            const monster = overloadedMonsters[i];
            monster.currentTarget = freePlayer;
            monster.targetLockTime = Date.now() + 5000;
        }
    }
}

function updateServerMonsters(deltaTime, players) {
    const now = Date.now();
    
    for (let i = serverMonsters.length - 1; i >= 0; i--) {
        const m = serverMonsters[i];
        
        if (m.vida <= 0) {
            recycleMonsterId(m.id); 
            serverMonsters.splice(i, 1);
            continue;
        }

        // Processa dano de sangramento ativo no servidor
        if (m.isBleeding && m.bleedDamagePerSecond > 0) {
            m.bleedTickTimer = (m.bleedTickTimer || 0) + deltaTime;
            if (m.bleedTickTimer >= 1000) {
                const ticks = Math.floor(m.bleedTickTimer / 1000);
                const damageToDeal = m.bleedDamagePerSecond * ticks;
                m.vida -= damageToDeal;
                m.bleedTickTimer %= 1000;
                m.isHit = true;
                
                if (GameManager.broadcastCallback) {
                    GameManager.broadcastCallback({
                        type: 'spawn-blood-particles',
                        payload: { x: m.x + m.hitboxOffsetX, y: m.y + m.hitboxOffsetY }
                    });
                }
                
                if (m.vida <= 0) {
                    GameManager.addXp(m.xpValue || 20, GameManager.broadcastCallback);
                    recycleMonsterId(m.id);
                    serverMonsters.splice(i, 1);
                    continue;
                }
            }
        }

        // =================================================================
        // ZONA DE EXCLUSÃO RIGIDA E RESET DE NASCIMENTO NO CÉU
        // =================================================================
        // Barreiras físicas das torres de pedra: esquerda em 120, direita em 2056.
        // Limite inferior do chão: 980. Limite superior ativo do céu: 100.
        const outOfBoundsLeft = m.x < 120;
        const outOfBoundsRight = m.x > 2056;
        const outOfBoundsBottom = m.y > 980;
        const outOfBoundsCeiling = m.hasLanded && m.y < 100;

        const isOutOfBounds = outOfBoundsLeft || outOfBoundsRight || outOfBoundsBottom || outOfBoundsCeiling;
        
        if (isOutOfBounds) {
            // Se bugar fora dos limites das torres, reseta ele para o céu para descer como monstro novo
            m.x = Math.random() * (1900 - 200) + 200; // Ponto X seguro
            m.y = -64; // Seta no topo do céu
            m.targetY = Math.random() * (750 - 250) + 250; // Novo Y de aterrissagem seguro
            m.hasLanded = false; // Força nova queda
            m.velX = 0;
            m.velY = 2; // Força velocidade de queda base
            continue;
        }

        // =================================================================
        // EVITAÇÃO DE TETO (GRAVIDADE ARTIFICIAL)
        // =================================================================
        // Se o monstro estiver na metade de cima da tela (Y < 350), aplica uma força constante de descida
        if (m.hasLanded && m.y < 350) {
            m.y += 1.5; 
        }

        let targetPlayer = null;

        if (m.targetLockTime && now < m.targetLockTime) {
            targetPlayer = m.currentTarget;
        } else {
            m.targetLockTime = null;
            if (players.length > 0) {
                let closestDist = Infinity;
                for (const p of players) {
                    const dist = Math.hypot(m.x - p.x, m.y - p.y);
                    if (dist < closestDist) {
                        closestDist = dist;
                        targetPlayer = p;
                    }
                }
            }
        }
        m.currentTarget = targetPlayer;

        if (targetPlayer) {
            const playerCY = targetPlayer.y + targetPlayer.hitboxHeight / 2;
            const monstroCY = m.y + m.hitboxOffsetY;
            const playerCX = targetPlayer.x + targetPlayer.hitboxWidth / 2;
            const monstroCX = m.x + m.hitboxOffsetX;
            m.angle = Math.atan2(playerCY - monstroCY, playerCX - monstroCX);
        }

        if (!m.hasLanded) {
            // Aumentado multiplicador de queda para fazê-los despencar do céu mais rapidamente
            m.y += (m.velY * 3) * (deltaTime / 16.67);
            if (m.y >= m.targetY) {
                m.y = m.targetY;
                m.hasLanded = true;
            }
        } else {
            m.x += (Math.random() - 0.5) * 2;
            m.y += (Math.random() - 0.5) * 1;
            if (targetPlayer) {
                const playerCX = targetPlayer.x + targetPlayer.hitboxWidth / 2;
                const monstroCX = m.x + m.hitboxOffsetX;
                const dx = playerCX - monstroCX;
                m.velX = Math.sign(dx) * m.speed * (0.3 + Math.random() * 0.7);
                m.x += m.velX * (deltaTime / 16.67);
            }
        }
        
        if (m.hasLanded) {
            for (let j = serverMonsters.length - 1; j >= 0; j--) {
                if (i === j) continue;
                const outro = serverMonsters[j];
                if (outro && outro.hasLanded) {
                    const dx = (m.x + m.hitboxOffsetX) - (outro.x + outro.hitboxOffsetX);
                    const dy = (m.y + m.hitboxOffsetY) - (outro.y + outro.hitboxOffsetY);
                    const dist = Math.hypot(dx, dy);
                    const personalSpace = 5;
                    const minDist = m.hitboxRadius + outro.hitboxRadius + personalSpace;
                    if (dist < minDist && dist > 0) {
                        const overlap = minDist - dist;
                        const angle = Math.atan2(dy, dx);
                        m.x += overlap * Math.cos(angle);
                        m.y += overlap * Math.sin(angle);
                    }
                }
            }
        }

        // Processa colisões de toque e reflexão
        for (const pId in serverPlayers) {
            const p = serverPlayers[pId];
            if (!p) continue;
            if (!serverConnections[pId]) continue; 

            const playerCX = p.x + p.hitboxWidth / 2;
            const playerCY = p.y + p.hitboxHeight / 2;
            const monstroCX = m.x + m.hitboxOffsetX;
            const monstroCY = m.y + m.hitboxOffsetY;

            const dist = Math.hypot(monstroCX - playerCX, monstroCY - playerCY);
            const touchDist = m.hitboxRadius + 24; 

            if (dist < touchDist) {
                const now = Date.now();
                if (!m.lastTouchDamageTime || now - m.lastTouchDamageTime > 1000) {
                    m.lastTouchDamageTime = now;
                    
                    GameManager.takeDamage(m.damage || 20, GameManager.broadcastCallback);
                    
                    const reflectTouchMult = p.stats ? p.stats.reflectTouchDamageMultiplier : 0;
                    if (reflectTouchMult > 0) {
                        const reflectDamage = (p.stats.attack || 20) * reflectTouchMult;
                        m.vida -= reflectDamage;
                        m.isHit = true;
                        
                        if (GameManager.broadcastCallback) {
                            GameManager.broadcastCallback({
                                type: 'spawn-impact',
                                payload: { x: monstroCX, y: monstroCY, color: 'red' }
                            });
                        }
                        
                        if (m.vida <= 0) {
                            GameManager.addXp(m.xpValue || 20, GameManager.broadcastCallback);
                            recycleMonsterId(m.id);
                            serverMonsters.splice(i, 1);
                            break;
                        }
                    }
                }
            }
        }
        
        // BARREIRAS FÍSICAS RÍGIDAS (Clamping)
        // Limita de forma estrita a movimentação dos monstros para que fiquem sempre na área visível
        m.x = Math.max(120, Math.min(2056 - m.width, m.x));
        m.y = Math.max(100, Math.min(950, m.y));
    }
}

const GameManager = {
    broadcastCallback: null,

    getGameState() {
        return gameState;
    },

    setServerConnections(connections) {
        serverConnections = connections;
    },

    // Retorna true se a vaga física estiver livre e o mago parado há mais de 5s
    isSlotTakeoverReady(slot) {
        if (!serverPlayers[slot]) return false;
        if (serverConnections[slot]) return false; 
        const discTime = playerDisconnectTime[slot];
        if (!discTime) return true; 
        return (Date.now() - discTime) >= 5000; 
    },

    getTokens() {
        return playerTokens;
    },

    registerToken(slot, token) {
        playerTokens[slot] = token;
        playerDisconnectTime[slot] = null;
    },

    registerDisconnectTime(slot) {
        playerDisconnectTime[slot] = Date.now();
    },

    runSimulation(broadcast) {
        GameManager.broadcastCallback = broadcast;
        if (gameLoopInterval) clearInterval(gameLoopInterval);
        
        let balanceCounter = 0;

        gameLoopInterval = setInterval(() => {
            const playersArray = Object.values(serverPlayers).filter(p => !!serverConnections[p.id]);
            if (playersArray.length === 0 || gameState.isPaused) return;

            // Sincronia de HP Regen (Média Cooperativa)
            let totalHpRegen = 0;
            let activeCount = 0;
            for (const pId in serverPlayers) {
                if (serverPlayers[pId] && serverPlayers[pId].stats && serverConnections[pId]) {
                    totalHpRegen += (serverPlayers[pId].stats.hpRegen || 0);
                    activeCount++;
                }
            }
            if (totalHpRegen > 0 && activeCount > 0 && gameState.sharedLife < gameState.sharedLifeMax) {
                const averageRegen = totalHpRegen / activeCount;
                const regenAmount = averageRegen * (GAME_INTERVAL / 1000);
                gameState.sharedLife = Math.min(gameState.sharedLifeMax, gameState.sharedLife + regenAmount);
            }

            // Reposição gradual de hordas
            if (serverMonsters.length < MAX_ON_SCREEN_MONSTERS && monsterStock.length > 0) {
                const spawnCount = Math.min(2, MAX_ON_SCREEN_MONSTERS - serverMonsters.length);
                for (let k = 0; k < spawnCount; k++) {
                    if (monsterStock.length === 0) break;
                    const nextMonster = monsterStock.shift();
                    const m = spawnServerMonster(nextMonster.tipo, nextMonster.config);
                    
                    GameManager.broadcastCallback({
                        type: 'monster-spawned',
                        payload: {
                            id: m.id, tipo: m.tipo, x: m.x, y: m.y,
                            config: configPadrao(m.tipo)
                        }
                    });
                }
                
                GameManager.syncGameState(GameManager.broadcastCallback);
            }

            if (monsterStock.length === 0 && serverMonsters.length === 0 && gameState.isGameRunning) {
                GameManager.startNextHorde();
            }

            updateServerMonsters(GAME_INTERVAL, playersArray);
            
            balanceCounter++;
            if (balanceCounter >= 30) {
                balanceMonsterTargets(playersArray);
                balanceCounter = 0;
            }
            
            const monsterUpdatePayload = serverMonsters.map(m => [
                m.id,
                Math.round(m.x),
                Math.round(m.y),
                parseFloat(m.angle.toFixed(2)),
                m.vida,
                getSpriteCode(m.currentSprite)
            ]);

            GameManager.broadcastCallback({ type: 'monsters-update', payload: monsterUpdatePayload });
            
            serverMonsters.forEach(m => { if(m.isHit) m.isHit = false; });

        }, GAME_INTERVAL);
    },

    stopSimulation() {
        if (gameLoopInterval) {
            clearInterval(gameLoopInterval);
            gameLoopInterval = null;
        }
        serverMonsters = [];
        monsterStock = [];
        
        availableMonsterIds = [];
        for (let i = 1; i <= 30; i++) {
            availableMonsterIds.push(`m${i}`);
        }
    },
    
    addPlayer(playerNumber) {
        serverPlayers[playerNumber] = {
            id: playerNumber, x: 1088, y: 900,
            hitboxWidth: 48, hitboxHeight: 60,
            stats: { 
                bleedDamage: 0, 
                reflectTouchDamageMultiplier: 0, 
                reflectProjectileDamageMultiplier: 0, 
                fragmentationProjectiles: 0, 
                attack: 20,
                vida: 0, 
                xpGainMultiplier: 0 
            }
        };
        playerLevel[playerNumber] = gameState.level; 
    },

    removePlayer(playerNumber) {
        delete serverPlayers[playerNumber];
        delete playerTokens[playerNumber];
        delete playerDisconnectTime[playerNumber];
        delete playerLevel[playerNumber];
    },

    updatePlayerPosition(playerNumber, data) {
        if (serverPlayers[playerNumber]) {
            serverPlayers[playerNumber].x = data.x;
            serverPlayers[playerNumber].y = data.y;
        }
    },

    applyMonsterDamage(monsterId, damage, playerNumber) {
        const monster = serverMonsters.find(m => m.id === monsterId);
        if (monster) {
            monster.vida -= damage;
            monster.isHit = true;

            const p = serverPlayers[playerNumber];
            const bleedDmg = p && p.stats ? p.stats.bleedDamage : 0;
            if (bleedDmg > 0) {
                monster.bleedDamagePerSecond = (monster.bleedDamagePerSecond || 0) + bleedDmg;
                monster.isBleeding = true;
            }
            
            if (monster.vida <= 0) {
                const fragCount = p && p.stats ? Math.floor(p.stats.fragmentationProjectiles) : 0;
                if (fragCount > 0 && GameManager.broadcastCallback) {
                    GameManager.broadcastCallback({
                        type: 'spawn-fragment-projectiles',
                        payload: {
                            x: monster.x + monster.hitboxOffsetX,
                            y: monster.y + monster.hitboxOffsetY,
                            count: fragCount,
                            damage: (p.stats.attack || 20) * 0.10 
                        }
                    });
                }

                // MÉDIA COOPERATIVA (OPÇÃO 2)
                let totalXpMult = 0;
                let activeCount = 0;
                for (const pId in serverPlayers) {
                    if (serverPlayers[pId] && serverPlayers[pId].stats) {
                        totalXpMult += (serverPlayers[pId].stats.xpGainMultiplier || 0);
                        activeCount++;
                    }
                }
                const averageXpMult = activeCount > 0 ? (totalXpMult / activeCount) : 0;
                const xpMultiplier = 1 + averageXpMult;
                const baseXP = monster.xpValue || 20;
                const finalXP = Math.round(baseXP * xpMultiplier);

                GameManager.addXp(finalXP, GameManager.broadcastCallback);
                recycleMonsterId(monster.id); 
                GameManager.syncGameState(GameManager.broadcastCallback);
            }
        }
    },

    registerRuneChoice(playerNumber, rune) {
        const p = serverPlayers[playerNumber];
        if (p && p.stats && rune.efeito) {
            for (let key in rune.efeito) {
                p.stats[key] = (p.stats[key] || 0) + rune.efeito[key];
            }
            
            // MÉDIA COOPERATIVA (OPÇÃO 2)
            let totalBonusVida = 0;
            let activeCount = 0;
            for (const pId in serverPlayers) {
                if (serverPlayers[pId] && serverPlayers[pId].stats) {
                    totalBonusVida += (serverPlayers[pId].stats.vida || 0);
                    activeCount++;
                }
            }
            const averageBonusVida = activeCount > 0 ? (totalBonusVida / activeCount) : 0;
            gameState.sharedLifeMax = 1000 + Math.round(averageBonusVida);
            gameState.sharedLife = Math.min(gameState.sharedLifeMax, gameState.sharedLife + (rune.efeito.vida || 0));
        }

        if (rune.efeito && rune.efeito.raioCenarioIntervalReduction) {
            gameState.sharedRaioCenarioReduction += rune.efeito.raioCenarioIntervalReduction;
        }

        // Decrementa o contador numérico de escolhas pendentes deste jogador específico
        if (pendingRuneChoicesCount[playerNumber] > 0) {
            pendingRuneChoicesCount[playerNumber]--;
            console.log(`[Rune-Choice] Decrementado contador do Jogador ${playerNumber}. Restam ${pendingRuneChoicesCount[playerNumber]} escolhas para ele.`);
        } else {
            console.log(`[Rune-Choice] Alerta: Jogador ${playerNumber} enviou escolha mas seu contador já estava em ${pendingRuneChoicesCount[playerNumber] || 0}.`);
        }

        console.log(`[Rune-Choice] Estado atual da fila de escolhas pendentes:`, JSON.stringify(pendingRuneChoicesCount));

        // CORREÇÃO: O servidor agora valida todas as escolhas de TODOS os jogadores registrados na memória (serverPlayers)
        // para impedir que o jogo despause se um deles cair/desconectar no meio da rodada de upgrades
        let allChoicesResolved = true;
        for (const pId in serverPlayers) {
            const remaining = pendingRuneChoicesCount[pId] || 0;
            if (remaining > 0) {
                allChoicesResolved = false;
                console.log(`[Rune-Choice] Ainda bloqueado: Jogador ${pId} possui ${remaining} escolhas restantes.`);
            }
        }

        if (allChoicesResolved) {
            console.log(`[Rune-Choice] TODOS OS JOGADORES CONCLUÍRAM AS ESCOLHAS! Retomando a simulação do jogo.`);
            pendingRuneChoicesCount = {};
            gameState.isPaused = false;
            isLevelUpLock = false; 
            
            GameManager.broadcastCallback({
                type: 'pause-state-change',
                payload: { isPaused: false }
            });
            GameManager.syncGameState(GameManager.broadcastCallback);
        }
    },

    // Sincroniza e iguala o nível e os atributos do jogador que voltou
    syncReconnectedPlayer(playerNumber, targetWs) {
        const otherPlayerNum = playerNumber === 1 ? 2 : 1;
        const other = serverPlayers[otherPlayerNum];
        const current = serverPlayers[playerNumber];

        if (current && targetWs && targetWs.readyState === 1) {
            // 1. Envia os status salvos do jogador de volta para o cliente dele (Resgate de Atributos)
            targetWs.send(JSON.stringify({
                type: 'player-stats-sync',
                payload: current.stats
            }));

            // 2. Envia uma lista instantânea de monstros ativos para ele desenhar a tela congelada na pausa
            const monsterUpdatePayload = serverMonsters.map(m => [
                m.id,
                Math.round(m.x),
                Math.round(m.y),
                parseFloat(m.angle.toFixed(2)),
                m.vida,
                getSpriteCode(m.currentSprite)
            ]);
            targetWs.send(JSON.stringify({
                type: 'monsters-update',
                payload: monsterUpdatePayload
            }));

            // 3. Se houver outro jogador ativo, copia seus status de runas (se for nova conexao/substituição)
            if (other && !playerTokens[playerNumber]) {
                current.stats = JSON.parse(JSON.stringify(other.stats));
            }

            // 4. Calcula se ele perdeu hordas/níveis comparando com o playerLevel em que ele desconectou
            const currentLoggedLevel = playerLevel[playerNumber] || 1;
            const levelsMissedWhileOffline = gameState.level - currentLoggedLevel;
            const choicesLeftBeforeDisconnect = pendingRuneChoicesCount[playerNumber] || 0;
            
            // Soma inteligente do que já estava devendo com os níveis que o parceiro subiu enquanto ele estava fora
            const totalChoicesToMake = choicesLeftBeforeDisconnect + levelsMissedWhileOffline;

            if (totalChoicesToMake > 0) {
                gameState.isPaused = true;
                isLevelUpLock = true;
                pendingRuneChoicesCount[playerNumber] = totalChoicesToMake;
                playerLevel[playerNumber] = gameState.level; // Atualiza o nível logado dele no banco do servidor

                console.log(`[Reconexão] Jogador ${playerNumber} voltou. Pendentes: ${choicesLeftBeforeDisconnect}, Ganhos fora: ${levelsMissedWhileOffline}. Alocando ${totalChoicesToMake} escolhas.`);

                // Pausa o jogo globalmente para ambos (para o parceiro não morrer sozinho)
                if (GameManager.broadcastCallback) {
                    GameManager.broadcastCallback({ type: 'pause-state-change', payload: { isPaused: true } });
                }

                // Envia as escolhas de runas apenas para quem reconectou
                targetWs.send(JSON.stringify({ type: 'level-up', payload: { levelsGained: totalChoicesToMake } }));
            } else {
                // Se não perdeu níveis e não tinha pendências, apenas atualiza o seu registro de nível atual do servidor
                playerLevel[playerNumber] = gameState.level;
            }
        }
    },

    startGame(broadcastCallback, grassSeed) {
        if (gameState.isGameRunning) return;

        console.log("[Game Manager] Iniciando novo jogo.");
        gameState.isGameRunning = true;
        gameState.isPaused = false;
        isLevelUpLock = false;
        gameState.sharedLife = 1000;
        gameState.sharedLifeMax = 1000;
        gameState.level = 1;
        gameState.xp = 0;
        gameState.xpMax = 100;
        gameState.currentHorde = 0;
        gameState.sharedRaioCenarioReduction = 0;
        pendingRuneChoicesCount = {}; // Reseta os contadores ativos
        playerLevel = { 1: 1, 2: 1 }; // Reseta o histórico de níveis logados
        
        GameManager.runSimulation(broadcastCallback);
        
        broadcastCallback({ type: 'start-game', payload: { grassSeed: grassSeed } }); 
        
        GameManager.syncGameState(broadcastCallback);
        GameManager.startNextHorde(); 
    },
    
    stopGame() {
        gameState.isGameRunning = false;
        GameManager.stopSimulation();
        console.log("[Game Manager] Jogo parado.");
        serverPlayers = {};
        playerTokens = {};
        playerDisconnectTime = {};
        playerLevel = {};
    },

    togglePause(broadcastCallback) {
        if (!gameState.isGameRunning || isLevelUpLock) return; 
        gameState.isPaused = !gameState.isPaused;
        console.log(`[Game Manager] Jogo ${gameState.isPaused ? 'pausado' : 'despausado'}.`);
        broadcastCallback({ type: 'pause-state-change', payload: { isPaused: gameState.isPaused } });
    },

    addXp(amount, broadcastCallback) {
        if (!gameState.isGameRunning || gameState.isPaused) return;

        gameState.xp += amount;
        let levelsGained = 0;

        while (gameState.xp >= gameState.xpMax) {
            gameState.level++;
            gameState.xp -= gameState.xpMax;
            gameState.xpMax = Math.floor(gameState.xpMax * 1.5);
            gameState.sharedLifeMax += 10;
            gameState.sharedLife = gameState.sharedLifeMax;
            levelsGained++;
        }
        
        if (levelsGained > 0) {
            console.log(`[Game Manager] Level Up! Nível atual: ${gameState.level}. Pausando para seleção de runas.`);
            
            // CORREÇÃO VISUAL: Antes de pausar, envia uma última sincronização de monstros limpa para evitar discrepâncias visuais na pausa
            const monsterUpdatePayload = serverMonsters.map(m => [
                m.id,
                Math.round(m.x),
                Math.round(m.y),
                parseFloat(m.angle.toFixed(2)),
                m.vida,
                getSpriteCode(m.currentSprite)
            ]);
            broadcastCallback({ type: 'monsters-update', payload: monsterUpdatePayload });

            gameState.isPaused = true;
            isLevelUpLock = true; 
            
            // Aloca a quantidade de escolhas obtidas nesta subida para todos os jogadores ativos na horda
            console.log(`[Level-Up] Sincronizando escolhas pendentes.`);
            for (const pId in serverPlayers) {
                if (serverConnections[pId]) {
                    pendingRuneChoicesCount[pId] = (pendingRuneChoicesCount[pId] || 0) + levelsGained;
                    playerLevel[pId] = gameState.level; // Sincroniza o nível logado de todos os ativos
                    console.log(`[Level-Up] Jogador ${pId} acumulou +${levelsGained} escolhas. Total dele: ${pendingRuneChoicesCount[pId]}`);
                }
            }

            broadcastCallback({ type: 'pause-state-change', payload: { isPaused: true } });
            broadcastCallback({ type: 'level-up', payload: { levelsGained: levelsGained } });
        }
        
        GameManager.syncGameState(GameManager.broadcastCallback);
    },

    takeDamage(amount, broadcastCallback) {
        if (!gameState.isGameRunning || gameState.isPaused) return;
        
        gameState.sharedLife -= amount;
        if (gameState.sharedLife < 0) {
            gameState.sharedLife = 0;
            console.log("[Game Manager] Game Over!");
        }

        GameManager.syncGameState(GameManager.broadcastCallback);
    },
    
    startNextHorde() {
        if (!gameState.isGameRunning) return;
        
        gameState.currentHorde++;
        console.log(`[Game Manager] Iniciando Horda ${gameState.currentHorde}.`);
        
        monsterStock = []; 
        
        const listObj = getHordeConfig(gameState.currentHorde);

        listObj.forEach(item => {
            for (let i = 0; i < item.quantidade; i++) {
                const baseCfg = configPadrao(item.tipo);
                const mergedConfig = { ...baseCfg, ...item.config };
                monsterStock.push({ tipo: item.tipo, config: mergedConfig });
            }
        });

        monsterStock.sort(() => Math.random() - 0.5);
        GameManager.syncGameState(GameManager.broadcastCallback);
    },

    // Sincroniza o status de pausa ativa do servidor no pacote de sincronia periódica
    syncGameState(broadcastCallback) {
        broadcastCallback({ type: 'game-state-sync', payload: {
            level: gameState.level, xp: gameState.xp, xpMax: gameState.xpMax,
            sharedLife: gameState.sharedLife, sharedLifeMax: gameState.sharedLifeMax,
            currentHorde: gameState.currentHorde,
            monsterStockLength: monsterStock.length,
            isPaused: gameState.isPaused 
        }});
    }
};

module.exports = GameManager;
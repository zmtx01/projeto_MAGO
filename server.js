// =================================================================
// SERVER.JS (Gerenciador de Protocolos e Comunicação - Sincronizado)
// =================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto'); // Biblioteca para geração de Tokens
const GameManager = require('./game_manager.js');

const server = http.createServer((req, res) => {
    const basePath = __dirname;
    const requestedUrl = req.url.split('?')[0]; 
    let filePath = path.join(basePath, requestedUrl === '/' ? 'main.html' : requestedUrl);
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
    };
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end(`404 Not Found: ${req.url}`);
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${error.code}`);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

const wss = new WebSocket.Server({ server });

let playerConnections = {};
GameManager.setServerConnections(playerConnections); // Vincula os sockets ao GameManager para monitoramento de inatividade

function getPlayerStates() {
    return {
        p1Connected: !!playerConnections[1],
        p2Connected: !!playerConnections[2],
        p1TakeoverReady: GameManager.isSlotTakeoverReady(1),
        p2TakeoverReady: GameManager.isSlotTakeoverReady(2)
    };
}

function broadcast(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

wss.on('connection', ws => {
    console.log(`Novo cliente estabelecendo conexão...`);

    ws.on('message', messageString => {
        try {
            const message = JSON.parse(messageString);
            
            switch (message.type) {
                // Handshake inicial que verifica tokens ou aloca slots livres
                case 'client-handshake':
                    const clientToken = message.payload.token;
                    let assignedSlot = null;
                    const activeTokens = GameManager.getTokens();

                    // 1. Tenta reconectar pelo Token da mesma máquina
                    if (clientToken) {
                        if (activeTokens[1] === clientToken) assignedSlot = 1;
                        else if (activeTokens[2] === clientToken) assignedSlot = 2;
                    }

                    // 2. Se não tem token, busca uma vaga vazia física
                    if (!assignedSlot) {
                        if (!playerConnections[1] && !GameManager.getGameState().isGameRunning) assignedSlot = 1;
                        else if (!playerConnections[2] && !GameManager.getGameState().isGameRunning) assignedSlot = 2;
                    }

                    // 3. Resposta de conexão bem-sucedida
                    if (assignedSlot) {
                        ws.playerNumber = assignedSlot;
                        playerConnections[assignedSlot] = ws;

                        if (!GameManager.getGameState().isGameRunning) {
                            GameManager.addPlayer(assignedSlot);
                        }

                        // Registra o token
                        const finalToken = clientToken || crypto.randomBytes(16).toString('hex');
                        GameManager.registerToken(assignedSlot, finalToken);

                        console.log(`P${assignedSlot} conectado (Token verificado).`);
                        ws.send(JSON.stringify({ 
                            type: 'player-assigned', 
                            payload: { playerNumber: assignedSlot, token: finalToken } 
                        }));
                        
                        broadcast({ type: 'update-player-status', payload: getPlayerStates() });
                        
                        if (GameManager.getGameState().isGameRunning) {
                            // Envia status atual e ativa sincronia de nível e pausa direcionada
                            ws.send(JSON.stringify({ type: 'game-state-sync', payload: GameManager.getGameState() }));
                            
                            // Passa o socket 'ws' do jogador reatribuído para o level-up ir estritamente para ele
                            GameManager.syncReconnectedPlayer(assignedSlot, ws);
                        }
                    } else {
                        // 4. CORREÇÃO: Mantém o socket do visitante aberto para permitir cliques em "Assumir Mago"
                        ws.send(JSON.stringify({ 
                            type: 'server-full', 
                            payload: getPlayerStates() 
                        }));
                    }
                    break;

                // Troca de máquina / Substituição por inatividade
                case 'request-takeover':
                    const requestedSlot = message.payload.slot;
                    if (GameManager.isSlotTakeoverReady(requestedSlot)) {
                        console.log(`Substituição aceita! Novo computador assumiu a vaga de P${requestedSlot}.`);
                        
                        ws.playerNumber = requestedSlot;
                        playerConnections[requestedSlot] = ws;

                        // Gera um token novo para a nova máquina
                        const newToken = crypto.randomBytes(16).toString('hex');
                        GameManager.registerToken(requestedSlot, newToken);

                        ws.send(JSON.stringify({ 
                            type: 'player-assigned', 
                            payload: { playerNumber: requestedSlot, token: newToken } 
                        }));

                        broadcast({ type: 'update-player-status', payload: getPlayerStates() });
                        ws.send(JSON.stringify({ type: 'game-state-sync', payload: GameManager.getGameState() }));
                        
                        // Passa o socket 'ws' do jogador substituto para o level-up ir estritamente para ele
                        GameManager.syncReconnectedPlayer(requestedSlot, ws);
                    }
                    break;

                case 'request-start-game':
                    if (playerConnections[1] && playerConnections[2]) {
                        broadcast({ type: 'prepare-to-start' });
                    }
                    break;

                case 'final-click':
                    if (playerConnections[1] && playerConnections[2] && !GameManager.getGameState().isGameRunning) {
                        const grassSeed = Math.random(); 
                        GameManager.startGame(broadcast, grassSeed);
                    }
                    break;

                case 'player-move':
                    GameManager.updatePlayerPosition(ws.playerNumber, message.payload);
                    message.payload.playerNumber = ws.playerNumber;
                    wss.clients.forEach(client => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'player-update', payload: message.payload }));
                        }
                    });
                    break;
                
                case 'monster-damaged':
                    if (message.payload && message.payload.id) {
                        // Passa o playerNumber para aplicar as runas de sangramento e fragmentação do atacante
                        GameManager.applyMonsterDamage(message.payload.id, message.payload.damage, ws.playerNumber);
                    }
                    break;

                case 'rune-chosen':
                    message.payload.playerNumber = ws.playerNumber;
                    wss.clients.forEach(client => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'apply-rune-effect', payload: message.payload }));
                        }
                    });
                    GameManager.registerRuneChoice(ws.playerNumber, message.payload);
                    break;

                case 'projectile-fired':
                case 'staff-lightning-used':
                case 'scenario-lightning-spawned':
                    const eventType = {
                        'projectile-fired': 'other-player-fired',
                        'staff-lightning-used': 'other-player-staff-lightning',
                        'scenario-lightning-spawned': 'other-player-scenario-lightning'
                    }[message.type];

                    message.payload.playerNumber = ws.playerNumber;
                    wss.clients.forEach(client => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: eventType, payload: message.payload }));
                        }
                    });
                    break;

                case 'request-toggle-pause':
                    GameManager.togglePause(broadcast);
                    break;

                case 'event-add-xp':
                    if (message.payload && typeof message.payload.amount === 'number') {
                        GameManager.addXp(message.payload.amount, broadcast);
                    }
                    break;
                
                case 'event-take-damage':
                     if (message.payload && typeof message.payload.amount === 'number') {
                        GameManager.takeDamage(message.payload.amount, broadcast);
                    }
                    break;
            }
            
        } catch (error) { console.error("Erro ao processar mensagem:", error); }
    });

    ws.on('close', () => {
        const disconnectedPlayer = ws.playerNumber;
        if (disconnectedPlayer) {
            console.log(`P${disconnectedPlayer} desconectado. Iniciando 5 segundos de inatividade...`);
            delete playerConnections[disconnectedPlayer];
            
            // Registra o timestamp da queda física para o temporizador de inatividade
            GameManager.registerDisconnectTime(disconnectedPlayer);
            
            broadcast({ type: 'player-disconnected', payload: { playerNumber: disconnectedPlayer } });
            broadcast({ type: 'update-player-status', payload: getPlayerStates() });
            
            if (Object.keys(playerConnections).length === 0) {
                GameManager.stopGame();
            }
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando. Abra seu navegador e acesse http://localhost:${PORT}`);
});

function shutdown() {
    console.log('\nRecebido sinal para desligar. Fechando o servidor...');
    GameManager.stopSimulation();
    wss.close(() => console.log('Servidor WebSocket fechado.'));
    server.close(() => { console.log('Servidor HTTP fechado. Encerrando processo.'); process.exit(0); });
    setTimeout(() => { console.error('Forçando o desligamento.'); process.exit(1); }, 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
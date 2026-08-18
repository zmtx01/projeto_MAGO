@echo off
title Wizz Game Server

:: Define a pagina de codigo do terminal para UTF-8, essencial para mostrar logs corretamente
chcp 65001 >nul

:: Garante que o script está executando na pasta onde ele se encontra
cd /d "%~dp0"

echo.
echo =================================
echo      INICIANDO SERVIDOR WIZZ
echo =================================
echo.
echo Servidor iniciado na pasta: %cd%
echo.
echo Pressione CTRL+C para parar o servidor.
echo.

:: Limpa qualquer processo 'node.exe' antigo para evitar conflitos de porta.
:: O '>nul 2>&1' esconde as mensagens de sucesso ou erro deste comando.
taskkill /F /IM node.exe /T >nul 2>&1

:: Uma pequena pausa para garantir que o processo foi encerrado
timeout /t 1 >nul

:: Executa o script "dev" definido no seu package.json.
:: O comando 'call' garante que esta janela do terminal espere o 'npm' terminar
:: (o que só acontecerá quando você parar o nodemon com CTRL+C).
call npm run dev

:: O script só chegará aqui depois que você parar o servidor manualmente.
echo.
echo =================================
echo      SESSAO DO SERVIDOR FINALIZADA
echo =================================
echo.
pause
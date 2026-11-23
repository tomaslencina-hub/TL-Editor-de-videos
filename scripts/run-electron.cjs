/**
 * Lanza Electron con un entorno limpio.
 * Algunas terminales (p. ej. procesos hijos de VS Code) heredan ELECTRON_RUN_AS_NODE=1,
 * lo que hace que Electron arranque como Node puro y falle. Acá se elimina.
 */
const { spawn } = require('node:child_process');
const electron = require('electron'); // ruta al binario

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: false });
child.on('close', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));

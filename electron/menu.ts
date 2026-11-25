import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { MenuAction } from '../shared/ipc-contract';

export function buildMenu(getWindow: () => BrowserWindow | null): Menu {
  const send = (action: MenuAction) => () => getWindow()?.webContents.send('menu:action', action);

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Archivo',
      submenu: [
        { label: 'Nuevo proyecto', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Abrir proyecto…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Guardar', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Guardar como…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
        { label: 'Importar proyecto de Filmora (.wfp)…', click: send('import-filmora') },
        { type: 'separator' },
        { label: 'Importar medios…', accelerator: 'CmdOrCtrl+I', click: send('import') },
        { label: 'Exportar MP4…', accelerator: 'CmdOrCtrl+E', click: send('export') },
        { type: 'separator' },
        { role: 'quit', label: 'Salir' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        // Deshacer/rehacer los maneja el historial del proyecto. Los atajos se procesan en el renderer
        // (registerAccelerator: false) para no pisar el deshacer nativo de los campos de texto.
        { label: 'Deshacer', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: send('undo') },
        { label: 'Rehacer', accelerator: 'CmdOrCtrl+Y', registerAccelerator: false, click: send('redo') },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload', label: 'Recargar' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

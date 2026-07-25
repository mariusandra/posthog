import { app, Menu, type MenuItemConstructorOptions, shell } from 'electron'

export interface MenuActions {
    showShell: () => void
    /** Opens a new PostHog window when signed in; no-op otherwise */
    newWindow: () => void
    /** Opens a new tab in the focused window */
    newTab: () => void
    /** Closes the focused window's active tab, or the window itself on the last one */
    closeTab: () => void
    checkForUpdates: () => void
}

export function buildAppMenu(actions: MenuActions): void {
    const isMac = process.platform === 'darwin'

    const template: MenuItemConstructorOptions[] = [
        ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
        {
            label: 'File',
            submenu: [
                {
                    label: 'New tab',
                    accelerator: 'CmdOrCtrl+T',
                    click: () => actions.newTab(),
                },
                {
                    label: 'New window',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => actions.newWindow(),
                },
                { type: 'separator' },
                // Deliberately not `role: 'close'`: that role owns CmdOrCtrl+W and would shut
                // the whole window on a keypress people expect to close one tab. Closing the
                // last tab falls through to closing the window, so the role's behavior is
                // still reachable, just not one keystroke away from losing every other tab.
                {
                    label: 'Close tab',
                    accelerator: 'CmdOrCtrl+W',
                    click: () => actions.closeTab(),
                },
                isMac ? { role: 'close', label: 'Close window', accelerator: 'CmdOrCtrl+Shift+W' } : { role: 'quit' },
                { type: 'separator' },
                {
                    label: 'Settings',
                    accelerator: 'CmdOrCtrl+,',
                    click: () => actions.showShell(),
                },
            ],
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        { role: 'windowMenu' },
        {
            role: 'help',
            submenu: [
                {
                    label: 'PostHog docs',
                    click: () => void shell.openExternal('https://posthog.com/docs'),
                },
                { type: 'separator' },
                {
                    label: 'Check for updates…',
                    click: () => actions.checkForUpdates(),
                },
                {
                    label: `Version ${app.getVersion()}`,
                    enabled: false,
                },
            ],
        },
    ]

    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

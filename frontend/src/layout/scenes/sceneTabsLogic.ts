import { MakeLogicType, afterMount, beforeUnmount, connect, kea, listeners, path } from 'kea'
import { router } from 'kea-router'
import { subscriptions } from 'kea-subscriptions'

import { isDesktopApp, isDesktopFreshWindow } from 'lib/utils/isDesktopApp'
import { addProjectIdIfMissing } from 'lib/utils/kea-router'
import { NEW_INTERNAL_TAB } from 'lib/utils/newInternalTab'
import {
    DESKTOP_TABS_STORAGE_KEY,
    TabOpenSource,
    generateTabId,
    markDesktopTabsRestored,
    sceneLogic,
} from 'scenes/sceneLogic'
import { SceneTab } from 'scenes/sceneTypes'

import type { InsightShortId } from '~/types'

/**
 * Desktop integration layer for the in-app scene tabs (products/desktop). The tab state itself —
 * tabs, per-tab mounted scene logics, pin/close/reorder/rename — lives in `sceneLogic`; this logic
 * only adds what is desktop-specific: restoring the persisted tab set on launch, fresh additional
 * windows, opening background tabs from `newInternalTab`, and eagerly keeping high-traffic
 * resources mounted for restored tabs. Values and actions are passthroughs so the tab strip
 * components can keep a single import. Mounted only when `isDesktopApp()`.
 */

export type { TabCloseSource, TabOpenSource } from 'scenes/sceneLogic'

/** Kept as an alias — the desktop strip predates tabs returning to `SceneTab` itself. */
export type DesktopSceneTab = SceneTab

const freshTab = (overrides: Partial<SceneTab> = {}): SceneTab => ({
    id: generateTabId(),
    active: true,
    pathname: '/new',
    search: '',
    hash: '',
    title: 'New tab',
    iconType: 'search',
    pinned: false,
    ...overrides,
})

const getPersistedTabs = (): SceneTab[] | null => {
    try {
        const saved = localStorage.getItem(DESKTOP_TABS_STORAGE_KEY)
        if (saved) {
            const parsed = JSON.parse(saved)
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed.map((tab) => ({ ...tab, id: tab.id || generateTabId() }))
            }
        }
    } catch (e) {
        console.error('Failed to parse saved desktop tabs:', e)
    }
    return null
}

interface TabKeepAliveEntry {
    /** Prefix for the keep-alive cache key */
    name: string
    /** Matched against the tab pathname; capture group 1 (when present) is the resource id */
    pattern: RegExp
    /** Skip transient ids like 'new' */
    skip?: (id: string) => boolean
    /** Lazy-imports the scene chunk and mounts the logic; returns the unmount fn */
    mount: (id: string) => Promise<() => void>
}

/**
 * Eager keep-alive for high-traffic resources: for every open tab that points at one of these,
 * mount the resource's root logic even if the tab was restored from disk and never activated, so
 * its content is already loaded when the tab is first clicked. Per-tab scene state itself is kept
 * by sceneLogic's per-tab mounted scene logics; this list only buys the preload. Note: the
 * resource logics here are keyed by resource, so two tabs on the same resource share one instance.
 */
const TAB_KEEP_ALIVE: TabKeepAliveEntry[] = [
    {
        name: 'notebook',
        pattern: /\/notebooks\/([^/?#]+)$/,
        skip: (id) => id === 'new',
        mount: async (shortId) => {
            const [{ notebookLogic }, { NotebookTarget }] = await Promise.all([
                import('scenes/notebooks/Notebook/notebookLogic'),
                import('scenes/notebooks/types'),
            ])
            return notebookLogic({ shortId, target: NotebookTarget.Scene }).mount()
        },
    },
    {
        name: 'insight',
        pattern: /\/insights\/([^/?#]+)/,
        skip: (id) => id === 'new' || id.startsWith('new-'),
        mount: async (shortId) => {
            const { insightLogic } = await import('scenes/insights/insightLogic')
            // Bare dashboardItemId yields the same kea key the insight scene builds (no tabId/dashboardId)
            return insightLogic({ dashboardItemId: shortId as InsightShortId }).mount()
        },
    },
    {
        name: 'dashboard',
        pattern: /\/dashboard\/(\d+)/,
        mount: async (id) => {
            const { dashboardLogic } = await import('scenes/dashboard/dashboardLogic')
            return dashboardLogic({ id: parseInt(id) }).mount()
        },
    },
    {
        name: 'feature-flag',
        pattern: /\/feature_flags\/(\d+)/,
        mount: async (id) => {
            const { featureFlagLogic } = await import('scenes/feature-flags/featureFlagLogic')
            return featureFlagLogic({ id: parseInt(id) }).mount()
        },
    },
    {
        name: 'experiment',
        pattern: /\/experiments\/(\d+)/,
        mount: async (id) => {
            const { experimentLogic } = await import('scenes/experiments/experimentLogic')
            return experimentLogic({ experimentId: parseInt(id) }).mount()
        },
    },
    // List scenes are singleton logics: keeping them mounted preserves filters and loaded results
    {
        name: 'insights-list',
        pattern: /\/insights\/?$/,
        mount: async () => (await import('scenes/saved-insights/savedInsightsLogic')).savedInsightsLogic.mount(),
    },
    {
        name: 'dashboards-list',
        pattern: /\/dashboard\/?$/,
        mount: async () => (await import('scenes/dashboard/dashboards/dashboardsLogic')).dashboardsLogic.mount(),
    },
    {
        name: 'feature-flags-list',
        pattern: /\/feature_flags\/?$/,
        mount: async () => (await import('scenes/feature-flags/featureFlagsLogic')).featureFlagsLogic.mount(),
    },
    {
        name: 'experiments-list',
        pattern: /\/experiments\/?$/,
        mount: async () => (await import('scenes/experiments/experimentsLogic')).experimentsLogic.mount(),
    },
    {
        name: 'notebooks-list',
        pattern: /\/notebooks\/?$/,
        mount: async () =>
            (await import('scenes/notebooks/NotebooksTable/notebooksTableLogic')).notebooksTableLogic.mount(),
    },
]

const syncTabKeepAlive = (cache: Record<string, any>, tabs: SceneTab[]): void => {
    const keepAlive: Map<string, () => void> = (cache.tabKeepAlive ??= new Map())
    const wanted = new Map<string, { entry: TabKeepAliveEntry; id: string }>()
    for (const tab of tabs) {
        for (const entry of TAB_KEEP_ALIVE) {
            const match = tab.pathname.match(entry.pattern)
            if (!match) {
                continue
            }
            const id = match[1] ?? ''
            if (!entry.skip?.(id)) {
                wanted.set(`${entry.name}:${id}`, { entry, id })
            }
            break
        }
    }
    for (const [key, unmount] of keepAlive) {
        if (!wanted.has(key)) {
            keepAlive.delete(key)
            unmount()
        }
    }
    for (const [key, { entry, id }] of wanted) {
        if (!keepAlive.has(key)) {
            const placeholder = (): void => {}
            keepAlive.set(key, placeholder)
            void entry
                .mount(id)
                .then((unmount) => {
                    // Only keep the mount if the tab is still open and no newer sync raced us here
                    if (keepAlive.get(key) === placeholder) {
                        keepAlive.set(key, unmount)
                    } else {
                        unmount()
                    }
                })
                .catch(() => {
                    if (keepAlive.get(key) === placeholder) {
                        keepAlive.delete(key)
                    }
                })
        }
    }
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface sceneTabsLogicValues {
    activeTab: SceneTab | null // sceneLogic
    activeTabId: string | null // sceneLogic
    editingTabId: string | null // sceneLogic
    firstTabIsActive: boolean // sceneLogic
    frozenWidths: Record<string, number> | null // sceneLogic
    tabs: SceneTab[] // sceneLogic
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface sceneTabsLogicActions {
    activateTab: (tab: SceneTab) => {
        tab: SceneTab
    } // sceneLogic
    clearFrozenWidths: () => {
        value: true
    } // sceneLogic
    clickOnTab: (tab: SceneTab) => {
        tab: SceneTab
    } // sceneLogic
    closeTabId: (
        tabId: string,
        options?:
            | {
                  source?: import('scenes/sceneLogic').TabCloseSource
              }
            | undefined
    ) => {
        options:
            | {
                  source?: import('scenes/sceneLogic').TabCloseSource | undefined
              }
            | undefined
        tabId: string
    } // sceneLogic
    duplicateTab: (tab: SceneTab) => {
        tab: SceneTab
    } // sceneLogic
    endTabEdit: () => {
        value: true
    } // sceneLogic
    freezeTabWidths: () => {
        value: true
    } // sceneLogic
    newTab: (
        href?: string | null | undefined,
        options?:
            | {
                  activate?: boolean
                  id?: string
                  skipNavigate?: boolean
                  source?: TabOpenSource
                  title?: string
              }
            | undefined
    ) => {
        href: string | null | undefined
        options:
            | {
                  activate?: boolean | undefined
                  id?: string | undefined
                  skipNavigate?: boolean | undefined
                  source?: TabOpenSource | undefined
                  title?: string | undefined
              }
            | undefined
        tabId: string
    } // sceneLogic
    pinTab: (tabId: string) => {
        tabId: string
    } // sceneLogic
    removeTab: (
        tab: SceneTab,
        options?:
            | {
                  source?: import('scenes/sceneLogic').TabCloseSource
              }
            | undefined
    ) => {
        options:
            | {
                  source?: import('scenes/sceneLogic').TabCloseSource | undefined
              }
            | undefined
        tab: SceneTab
    } // sceneLogic
    reorderTabs: (
        activeId: string,
        overId: string
    ) => {
        activeId: string
        overId: string
    } // sceneLogic
    saveTabEdit: (
        tab: SceneTab,
        name: string
    ) => {
        name: string
        tab: SceneTab
    } // sceneLogic
    setTabs: (tabs: SceneTab[]) => {
        tabs: SceneTab[]
    } // sceneLogic
    startTabEdit: (tab: SceneTab) => {
        tab: SceneTab
    } // sceneLogic
    unpinTab: (tabId: string) => {
        tabId: string
    } // sceneLogic
}

export type sceneTabsLogicType = MakeLogicType<sceneTabsLogicValues, sceneTabsLogicActions>

export const sceneTabsLogic = kea<sceneTabsLogicType>([
    path(['layout', 'scenes', 'sceneTabsLogic']),
    connect(() => ({
        values: [sceneLogic, ['tabs', 'activeTab', 'activeTabId', 'firstTabIsActive', 'editingTabId', 'frozenWidths']],
        actions: [
            sceneLogic,
            [
                'newTab',
                'setTabs',
                'activateTab',
                'clickOnTab',
                'closeTabId',
                'removeTab',
                'reorderTabs',
                'duplicateTab',
                'startTabEdit',
                'endTabEdit',
                'saveTabEdit',
                'pinTab',
                'unpinTab',
                'freezeTabWidths',
                'clearFrozenWidths',
            ],
        ],
    })),
    listeners(({ actions }) => ({
        [NEW_INTERNAL_TAB]: (payload: {
            path?: string
            source?: TabOpenSource
            activate?: boolean
            title?: string
        }) => {
            // Background tab by default, matching what cmd/ctrl+click does in a browser;
            // explicit "open in new tab" menu items pass activate: true
            actions.newTab(payload.path, {
                source: payload?.source ?? 'internal_link',
                activate: payload?.activate ?? false,
                skipNavigate: !(payload?.activate ?? false),
                title: payload?.title,
            })
        },
    })),
    subscriptions(({ cache }: { cache: Record<string, any> }) => ({
        tabs: (tabs: SceneTab[]) => {
            if (isDesktopApp()) {
                syncTabKeepAlive(cache, tabs)
            }
        },
    })),
    beforeUnmount(({ cache }) => {
        const keepAlive: Map<string, () => void> | undefined = cache.tabKeepAlive
        if (keepAlive) {
            for (const unmount of keepAlive.values()) {
                unmount()
            }
            keepAlive.clear()
        }
    }),
    afterMount(({ actions, values, cache }) => {
        if (!isDesktopApp()) {
            return
        }

        // Cmd+W / Cmd+T are owned by the app menu, which cannot touch tabs itself — they live
        // here. Closing the last tab falls through to closing the window, so the shortcut still
        // ends up doing what it does everywhere else once there is nothing left to close.
        // `pauseOnPageHidden: false`: a hidden window can be focused and sent a command in the
        // same breath, and a subscription still being re-established would swallow it.
        cache.disposables.add(
            () =>
                window.posthogDesktop?.onMenuCommand((command) => {
                    if (command === 'new-tab') {
                        actions.newTab()
                        return
                    }
                    const { activeTab, tabs } = values
                    if (!activeTab || tabs.length <= 1) {
                        void window.posthogDesktop?.closeWindow()
                    } else {
                        actions.removeTab(activeTab, { source: 'keyboard_shortcut' })
                    }
                }),
            'desktop-menu-commands',
            { pauseOnPageHidden: false }
        )
        const { currentLocation } = router.values
        const currentTab = freshTab({
            pathname: addProjectIdIfMissing(currentLocation.pathname),
            search: currentLocation.search,
            hash: currentLocation.hash,
            title: 'Loading...',
            iconType: 'loading',
        })

        const persisted = getPersistedTabs()
        // Persistence is gated on this so sceneLogic's boot placeholder tab (dispatched via
        // setTabs before this afterMount runs) cannot clobber the saved set we just read
        markDesktopTabsRestored()

        // Windows opened via "open in new window" / File → New window start with just the
        // opened location plus the pinned tabs, instead of cloning the whole saved tab set
        if (isDesktopFreshWindow()) {
            const pinned = (persisted ?? [])
                .filter((tab) => tab.pinned)
                .map((tab) => ({ ...tab, sceneParams: undefined, active: false }))
            const matchIndex = pinned.findIndex(
                (tab) =>
                    tab.pathname === currentTab.pathname &&
                    (tab.search ?? '') === currentTab.search &&
                    (tab.hash ?? '') === currentTab.hash
            )
            if (matchIndex !== -1) {
                actions.setTabs(pinned.map((tab, i) => ({ ...tab, active: i === matchIndex })))
            } else {
                actions.setTabs([...pinned, currentTab])
            }
            return
        }

        if (!persisted) {
            return
        }

        // Adopt the current location into the restored tab set: activate the matching tab,
        // otherwise point the previously active tab at where the app actually is. sceneLogic's
        // own afterMount already created a tab for the current location; setTabs replaces it.
        const restored = persisted.map((tab) => ({ ...tab, sceneParams: undefined }))

        // Whatever ends up active points at the location the app is already at, and the boot
        // tab has that scene loaded. The router won't fire again for a location it is already
        // on, so without inheriting the boot tab's scene the active tab has no scene to render
        // and sits on a spinner until it is closed and reopened. Its transient loading title
        // and icon are dropped for the same reason: nothing would refresh them either.
        const bootTab = sceneLogic.findMounted()?.values.activeTab
        const adoptBootScene = (tab: SceneTab): SceneTab => ({
            ...tab,
            sceneId: bootTab?.sceneId,
            sceneKey: bootTab?.sceneKey,
            sceneParams: bootTab?.sceneParams,
            // Title and icon come from the boot tab for the same reason as the scene: they
            // describe the location this tab now shows, and nothing else will refresh them
            // once the scene is inherited rather than loaded. A user's own rename lives in
            // `customTitle` and is left alone.
            ...(bootTab?.title && bootTab.title !== 'Loading...' ? { title: bootTab.title } : {}),
            iconType: bootTab?.iconType && bootTab.iconType !== 'loading' ? bootTab.iconType : 'blank',
        })
        const matchIndex = restored.findIndex(
            (tab) =>
                tab.pathname === currentTab.pathname &&
                (tab.search ?? '') === currentTab.search &&
                (tab.hash ?? '') === currentTab.hash
        )
        if (matchIndex !== -1) {
            actions.setTabs(
                restored.map((tab, i) =>
                    i === matchIndex ? adoptBootScene({ ...tab, active: true }) : { ...tab, active: false }
                )
            )
            return
        }
        const activeIndex = Math.max(
            restored.findIndex((tab) => tab.active),
            0
        )
        actions.setTabs(
            restored.map((tab, i) =>
                i === activeIndex
                    ? adoptBootScene({
                          ...tab,
                          active: true,
                          pathname: currentTab.pathname,
                          search: currentTab.search,
                          hash: currentTab.hash,
                          title: 'Loading...',
                          iconType: 'loading' as const,
                          customTitle: undefined,
                      })
                    : { ...tab, active: false }
            )
        )
    }),
])

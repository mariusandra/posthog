import { useActions, useValues } from 'kea'

import { ActivitySceneTabs } from 'scenes/activity/ActivitySceneTabs'
import { sceneConfigurations } from 'scenes/scenes'
import { Scene, SceneExport } from 'scenes/sceneTypes'

import { SceneContent } from '~/layout/scenes/components/SceneContent'
import { SceneTitleSection } from '~/layout/scenes/components/SceneTitleSection'
import { QueryFeature } from '~/queries/nodes/DataTable/queryFeatures'
import { Query } from '~/queries/Query/Query'
import { ProductKey } from '~/queries/schema/schema-general'
import { ActivityTab } from '~/types'

import { useAttachedContext } from 'products/posthog_ai/frontend/api/logics'

import { buildExploreAgentContext } from '../activityAgentContext'
import { eventsSceneLogic } from './eventsSceneLogic'

export function EventsScene({ tabId }: { tabId?: string } = {}): JSX.Element {
    const { query } = useValues(eventsSceneLogic({ tabId }))
    const { setQuery } = useActions(eventsSceneLogic({ tabId }))

    useAttachedContext(buildExploreAgentContext(ActivityTab.ExploreEvents, query))

    return (
        <SceneContent>
            <ActivitySceneTabs activeKey={ActivityTab.ExploreEvents} />
            <SceneTitleSection
                name={sceneConfigurations[Scene.Activity].name}
                description={sceneConfigurations[Scene.Activity].description}
                resourceType={{
                    type: sceneConfigurations[Scene.ExploreEvents].iconType || 'default_icon_type',
                }}
            />
            <Query
                attachTo={eventsSceneLogic({ tabId })}
                uniqueKey={`events-scene-${tabId}`}
                tabId={tabId}
                query={query}
                setQuery={setQuery}
                context={{
                    showOpenEditorButton: true,
                    extraDataTableQueryFeatures: [QueryFeature.highlightExceptionEventRows],
                    dataTableMaxPaginationLimit: 200,
                    // A live-data explorer over captured events, so it keeps the hidden ones selectable.
                    includeHiddenEvents: true,
                }}
            />
        </SceneContent>
    )
}

export const scene: SceneExport = {
    component: EventsScene,
    logic: eventsSceneLogic,
    productKey: ProductKey.PRODUCT_ANALYTICS,
}

import * as logfire from '@pydantic/logfire-browser'
import { vueRouterRouteName } from '@pydantic/logfire-browser/vue-router'
import { createApp, defineComponent, h, ref } from 'vue'
import { RouterLink, RouterView, createRouter, createWebHistory } from 'vue-router'
import type { RouteLocationNormalized, RouteLocationRaw, RouteRecordRaw } from 'vue-router'

interface ProjectData {
  id: string
  name: string
}

const projectName = ref('')

async function loadProject(to: RouteLocationNormalized): Promise<true | RouteLocationRaw> {
  // A slow guard shows that spans started while it runs keep the route of the
  // page whose URL is current.
  await new Promise((resolve) => setTimeout(resolve, 400))
  const response = await fetch(`/data/projects/${String(to.params['projectId'])}.json`)
  if (!response.ok) {
    return { name: 'not-found', params: { pathMatch: to.path.slice(1).split('/') } }
  }
  projectName.value = ((await response.json()) as ProjectData).name
  return true
}

const page = (render: () => ReturnType<typeof h>) => defineComponent(() => render)

const routes: RouteRecordRaw[] = [
  { component: page(() => h('h1', 'Home')), path: '/' },
  {
    children: [
      { component: page(() => h('h1', 'Projects')), path: '' },
      { component: page(() => h('h1', projectName.value)), name: 'project', path: ':projectId' },
    ],
    path: '/projects',
  },
  {
    children: [{ component: page(() => h('h1', 'Settings')), path: '' }],
    component: page(() => h('section', h(RouterView))),
    path: '/settings',
  },
  { component: page(() => h('h1', 'Page not found')), name: 'not-found', path: '/:pathMatch(.*)*' },
]

const router = createRouter({ history: createWebHistory(), routes })
// A route's beforeEnter guard skips navigations that only change its params, so
// load each project in a global guard.
router.beforeResolve((to) => (to.name === 'project' ? loadProject(to) : true))
const getRouteName = vueRouterRouteName(router)
const baseUrl = import.meta.env.VITE_LOGFIRE_BASE_URL
const token = import.meta.env.VITE_LOGFIRE_TOKEN

if (baseUrl !== undefined && token !== undefined) {
  logfire.configureFrontend({
    baseUrl,
    rum: { session: { getRouteName } },
    token,
  })
} else {
  console.warn('Set VITE_LOGFIRE_BASE_URL and VITE_LOGFIRE_TOKEN to send telemetry to Logfire.')
}

const routeName = ref<string | undefined>()
router.afterEach((_to, _from, failure) => {
  routeName.value = getRouteName()
  if (failure === undefined) {
    logfire.info('page viewed')
  }
})

const link = (to: string, label: string) => h(RouterLink, { to }, () => label)

const App = defineComponent(() => () => [
  h('nav', [
    link('/', 'Home'),
    ' | ',
    link('/projects', 'Projects'),
    ' | ',
    link('/projects/1', 'Project 1'),
    ' | ',
    link('/projects/2', 'Project 2'),
    ' | ',
    link('/settings', 'Settings'),
    ' | ',
    link('/missing/page', 'Missing page'),
  ]),
  h('p', ['Logfire route: ', h('code', { id: 'route-name' }, routeName.value)]),
  h(RouterView),
])

createApp(App).use(router).mount('#app')

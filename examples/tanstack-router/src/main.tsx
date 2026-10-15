import * as logfire from '@pydantic/logfire-browser'
import { tanStackRouterRouteName } from '@pydantic/logfire-browser/tanstack-router'
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  useLocation,
  useRouterState,
} from '@tanstack/react-router'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'

interface ProjectData {
  id: string
  name: string
}

const rootRoute = createRootRoute({ component: Layout, notFoundComponent: NotFound })
const homeRoute = createRoute({ component: Home, getParentRoute: () => rootRoute, path: '/' })
const projectsRoute = createRoute({ getParentRoute: () => rootRoute, path: 'projects' })
const projectsIndexRoute = createRoute({ component: Projects, getParentRoute: () => projectsRoute, path: '/' })
const projectRoute = createRoute({
  component: Project,
  // Drop cached project data when the page is left, so every visit runs the
  // slow loader again.
  gcTime: 0,
  getParentRoute: () => projectsRoute,
  loader: async ({ params }): Promise<ProjectData> => {
    // A slow loader shows that spans started while it runs keep the route of
    // the page whose URL is current.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const response = await fetch(`/data/projects/${params.projectId}.json`)
    if (!response.ok) {
      notFound({ throw: true })
    }
    return (await response.json()) as ProjectData
  },
  path: '$projectId',
})
// A pathless layout route adds nothing to the route template.
const accountRoute = createRoute({ component: AccountLayout, getParentRoute: () => rootRoute, id: '_account' })
const settingsRoute = createRoute({ component: Settings, getParentRoute: () => accountRoute, path: 'settings' })

const routeTree = rootRoute.addChildren([
  homeRoute,
  projectsRoute.addChildren([projectsIndexRoute, projectRoute]),
  accountRoute.addChildren([settingsRoute]),
])
const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const getRouteName = tanStackRouterRouteName(router)
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

function Layout() {
  const location = useLocation()
  const isLoading = useRouterState({ select: (state) => state.isLoading })

  useEffect(() => {
    logfire.info('page viewed')
  }, [location.pathname])

  return (
    <>
      <nav>
        <Link to="/">Home</Link> | <Link to="/projects">Projects</Link> |{' '}
        <Link params={{ projectId: '1' }} to="/projects/$projectId">
          Project 1
        </Link>{' '}
        |{' '}
        <Link params={{ projectId: '2' }} to="/projects/$projectId">
          Project 2
        </Link>{' '}
        | <Link to="/settings">Settings</Link> |{' '}
        <a
          href="/missing/page"
          onClick={(event) => {
            event.preventDefault()
            void router.navigate({ href: '/missing/page' })
          }}
        >
          Missing page
        </a>
      </nav>
      <p>
        Logfire route: <code id="route-name">{getRouteName()}</code> {isLoading ? '(loading)' : ''}
      </p>
      <Outlet />
    </>
  )
}

function Home() {
  return <h1>Home</h1>
}

function Projects() {
  return <h1>Projects</h1>
}

function Project() {
  const project = projectRoute.useLoaderData()
  return <h1>{project.name}</h1>
}

function AccountLayout() {
  return (
    <section>
      <Outlet />
    </section>
  )
}

function Settings() {
  return <h1>Settings</h1>
}

function NotFound() {
  return <h1>Page not found</h1>
}

const root = document.getElementById('root')
if (root === null) {
  throw new Error('Missing #root element')
}

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)

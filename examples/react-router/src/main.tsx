import * as logfire from '@pydantic/logfire-browser'
import { reactRouterRouteName } from '@pydantic/logfire-browser/react-router'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Link, Outlet, RouterProvider, createBrowserRouter, matchRoutes, useLoaderData, useLocation, useNavigation } from 'react-router'
import type { LoaderFunctionArgs, RouteObject } from 'react-router'

interface ProjectData {
  id: string
  name: string
}

async function loadProject({ params }: LoaderFunctionArgs): Promise<ProjectData> {
  // A slow loader shows that spans started while it runs keep the route of
  // the page whose URL is current.
  await new Promise((resolve) => setTimeout(resolve, 400))
  const response = await fetch(`/data/projects/${params['projectId'] ?? ''}.json`)
  if (!response.ok) {
    throw new Response('Project not found', { status: 404 })
  }
  return (await response.json()) as ProjectData
}

const routes: RouteObject[] = [
  {
    Component: Layout,
    children: [
      { Component: Home, index: true },
      {
        children: [
          { Component: Projects, index: true },
          { Component: Project, loader: loadProject, path: ':projectId' },
        ],
        path: 'projects',
      },
      // A pathless layout route adds nothing to the route template.
      { Component: AccountLayout, children: [{ Component: Settings, path: 'settings' }] },
      { Component: NotFound, path: '*' },
    ],
    path: '/',
  },
]

const getRouteName = reactRouterRouteName({ matchRoutes, routes })
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
  const navigation = useNavigation()

  useEffect(() => {
    logfire.info('page viewed')
  }, [location.pathname])

  return (
    <>
      <nav>
        <Link to="/">Home</Link> | <Link to="/projects">Projects</Link> | <Link to="/projects/1">Project 1</Link> |{' '}
        <Link to="/projects/2">Project 2</Link> | <Link to="/settings">Settings</Link> | <Link to="/missing/page">Missing page</Link>
      </nav>
      <p>
        Logfire route: <code id="route-name">{getRouteName()}</code> {navigation.state === 'loading' ? '(loading)' : ''}
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
  const project = useLoaderData<ProjectData>()
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
    <RouterProvider router={createBrowserRouter(routes)} />
  </StrictMode>
)

import { basename } from 'node:path'

import { createAuthenticatedClient } from '../authClient'
import type { LogfireApiClient, ProjectTokenResponse, QueryProjectRow, WritableProject } from '../client'
import { InvalidProjectNameError, ProjectAlreadyExistsError, queryProject } from '../client'
import type { CliContext, GlobalOptions } from '../context'
import {
  defaultDataDir,
  loadSavedReadToken,
  organizationFromProjectUrl,
  readProjectCredentials,
  writeProjectCredentials,
} from '../credentials'
import { LogfireCliError } from '../errors'
import { prettyTable, sanitizeForTerminal, writeLine } from '../output'

const PROJECT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

// How far back `projects status` looks. Long enough to cover a setup session, short
// enough that the answer is about what just happened rather than about last week.
const STATUS_LOOKBACK_HOURS = 1

// A ceiling on the rows this asks for, so it cannot become an enormous query. Should not
// bind in practice -- the result is one row per service -- but this runs against someone
// else's project and an unbounded query is not worth the surprise.
const STATUS_MAX_ROWS = 10_000

// One row per service: how much arrived and when it last did. Aggregated by the backend
// rather than pulling rows down and counting here, and counting RECORDS rather than
// spans -- the table holds both, and a service that only logs should not vanish from a
// command whose whole job is "is anything arriving from this service?".
const STATUS_SQL = 'SELECT service_name, count(*) AS records, max(start_timestamp) AS last_seen FROM records GROUP BY service_name'

interface ProjectCommandOptions {
  dataDir?: string
  defaultOrg: boolean
  org?: string
  projectName?: string
}

interface StatusOptions {
  dataDir?: string
  json: boolean
}

export async function runProjectsCommand(args: string[], globalOptions: GlobalOptions, context: CliContext): Promise<void> {
  const subcommand = args[0]
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    printProjectsHelp(context)
    return
  }
  if (subcommand === 'status') {
    // Deliberately does not call `createAuthenticatedClient`: `status` reads the token
    // saved by `read-tokens create --save`, not the CLI's own user session, so it needs
    // no login at all.
    await projectStatus(parseStatusOptions(args.slice(1)), context)
    return
  }

  const client = await createAuthenticatedClient(globalOptions, context)
  if (subcommand === 'list') {
    await listProjects(client, context)
    return
  }
  if (subcommand === 'new') {
    await newProject(client, parseProjectOptions(args.slice(1)), context)
    return
  }
  if (subcommand === 'use') {
    await useProject(client, parseProjectOptions(args.slice(1)), context)
    return
  }
  throw new LogfireCliError(`Unknown projects command "${subcommand}".`)
}

export function sanitizeProjectName(name: string): string {
  // Match Python's `sanitize_project_name`: strip every non-alphanumeric character (no
  // hyphens are introduced) so JS and Python suggest identical default project names. The
  // backend may append 9 characters on name collisions, so cap the base name at 41.
  const sanitized = name
    .replace(/[^a-zA-Z0-9]/gu, '')
    .toLowerCase()
    .slice(0, 41)
  return sanitized || 'untitled'
}

function printProjectsHelp(context: CliContext): void {
  writeLine(context.stdout, 'usage: logfire projects <command>')
  writeLine(context.stdout)
  writeLine(context.stdout, 'Commands:')
  writeLine(context.stdout, '  list    List projects')
  writeLine(context.stdout, '  new     Create a new project')
  writeLine(context.stdout, '  use     Use an existing project')
  writeLine(context.stdout, '  status  Show what telemetry has reached the current project')
}

/**
 * Show what telemetry has reached the project this directory is linked to. Reads the
 * token `read-tokens create --save` wrote rather than minting one: a read token is
 * permanent and this CLI has no way to revoke it, and this command is meant to be re-run
 * while waiting for data, so minting one per invocation would leave one behind on every
 * poll.
 */
async function projectStatus(options: StatusOptions, context: CliContext): Promise<void> {
  const dataDir = options.dataDir ?? defaultDataDir(context.cwd)
  const credentials = readProjectCredentials(dataDir)
  if (credentials === undefined) {
    throw new LogfireCliError(`No Logfire credentials found in ${dataDir}\nRun \`logfire projects use PROJECT_NAME\` first.`)
  }

  const organization = organizationFromProjectUrl(credentials.project_url)
  if (organization === undefined) {
    throw new LogfireCliError(`Cannot tell which organization ${credentials.project_url} belongs to.`)
  }

  const saved = loadSavedReadToken(dataDir, { organization, projectName: credentials.project_name })
  if (saved === undefined) {
    throw new LogfireCliError(
      `No usable read token for ${organization}/${credentials.project_name}.\n` +
        'Run `logfire read-tokens create --save` to create one, then try again.'
    )
  }

  const rows = await queryProject(saved.baseUrl, saved.token, STATUS_SQL, {
    fetch: context.fetch,
    limit: STATUS_MAX_ROWS,
    minTimestamp: new Date(Date.now() - STATUS_LOOKBACK_HOURS * 60 * 60 * 1000),
  })
  const services = sortByServiceName(rows)

  if (options.json) {
    writeLine(
      context.stdout,
      JSON.stringify({
        lookback_hours: STATUS_LOOKBACK_HOURS,
        organization,
        project_name: credentials.project_name,
        project_url: credentials.project_url,
        services: services.map((row) => ({
          last_seen: row['last_seen'],
          records: row['records'],
          service_name: row['service_name'],
        })),
      })
    )
    return
  }

  // `credentials` came from a file inside the project this command runs in (see
  // `saveReadToken`'s doc comment for the same threat model), so its fields get the same
  // stripping as a service name -- not JSON.stringify's escaping, because this is the
  // stderr summary, not the `--json` path above, which is already safe by construction.
  writeLine(context.stderr, `Project  ${sanitizeForTerminal(organization)}/${sanitizeForTerminal(credentials.project_name)}`)
  writeLine(context.stderr, `         ${sanitizeForTerminal(credentials.project_url)}`)
  writeLine(context.stderr)
  if (services.length === 0) {
    // Deliberately not phrased as failure. Data takes a moment to arrive, and the common
    // case for someone running this during setup is "not yet", not "broken".
    writeLine(context.stderr, `No telemetry in the last ${String(STATUS_LOOKBACK_HOURS)}h.`)
    writeLine(context.stderr, 'Run the application so it sends something, then try again.')
    return
  }
  context.stderr.write(
    prettyTable(
      ['Service', 'Records', 'Last seen'],
      services.map((row) => [
        printableCell(row['service_name'], '(unnamed)'),
        printableCell(row['records'], '0'),
        printableCell(row['last_seen'], '-'),
      ])
    )
  )
}

function sortByServiceName(rows: QueryProjectRow[]): QueryProjectRow[] {
  return [...rows].sort((a, b) => queryValueToString(a['service_name']).localeCompare(queryValueToString(b['service_name'])))
}

// The query result columns are typed `unknown` -- they come back as parsed JSON, so a
// plain `String(value)` risks `[object Object]` for anything that is not already a
// primitive. Every branch here stringifies a type `String()` is actually well-defined for.
function queryValueToString(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return JSON.stringify(value)
}

/** A telemetry-supplied value, safe to write to a terminal. `service_name` is submitted
 * by whoever sends the data, so it can carry ANSI escapes or other control characters;
 * written raw those could clear the screen, reposition the cursor, or forge rows in the
 * very table an operator is reading to decide whether their setup worked. */
function printableCell(value: unknown, fallback: string): string {
  const text = value === undefined || value === null || value === '' ? fallback : queryValueToString(value)
  return sanitizeForTerminal(text)
}

async function listProjects(client: LogfireApiClient, context: CliContext): Promise<void> {
  const projects = await client.getUserProjects()
  if (projects.length === 0) {
    writeLine(context.stderr, 'No projects found for the current user. You can create a new project with `logfire projects new`')
    return
  }

  writeLine(context.stderr, "List of the projects you have write access to (requires the 'write_token' permission):")
  writeLine(context.stderr)
  context.stderr.write(
    prettyTable(
      ['Organization', 'Project'],
      [...projects]
        .sort((a: WritableProject, b: WritableProject) =>
          `${a.organization_name}/${a.project_name}`.localeCompare(`${b.organization_name}/${b.project_name}`)
        )
        .map((project) => [project.organization_name, project.project_name])
    )
  )
}

async function newProject(client: LogfireApiClient, options: ProjectCommandOptions, context: CliContext): Promise<void> {
  const dataDir = options.dataDir ?? defaultDataDir(context.cwd)
  const organization = await selectOrganization(client, options, context)
  const project = await createProjectWithPrompt(client, organization, options.projectName, context)
  writeProjectCredentials(dataDir, { ...project, logfire_api_url: client.baseUrl })
  writeLine(context.stderr, `Project created successfully. You will be able to view it at: ${project.project_url}`)
}

async function useProject(client: LogfireApiClient, options: ProjectCommandOptions, context: CliContext): Promise<void> {
  const dataDir = options.dataDir ?? defaultDataDir(context.cwd)
  const project = await selectProject(client, options, context)
  if (project === undefined) {
    return
  }
  const credentials = await client.createWriteToken(project.organization_name, project.project_name)
  writeProjectCredentials(dataDir, { ...credentials, logfire_api_url: client.baseUrl })
  writeLine(context.stderr, `Project configured successfully. You will be able to view it at: ${credentials.project_url}`)
}

async function selectOrganization(client: LogfireApiClient, options: ProjectCommandOptions, context: CliContext): Promise<string> {
  const organizations = (await client.getUserOrganizations()).map((organization) => organization.organization_name)
  if (organizations.length === 0) {
    throw new LogfireCliError('No organizations found for the current user.')
  }
  if (options.org !== undefined && organizations.includes(options.org)) {
    return options.org
  }

  if (organizations.length === 1) {
    const organization = organizations[0]
    if (organization === undefined) {
      throw new LogfireCliError('No organizations found for the current user.')
    }
    if (!options.defaultOrg) {
      const confirmed = await context.prompt.confirm(`The project will be created in the organization "${organization}". Continue?`, true)
      if (!confirmed) {
        throw new LogfireCliError('Project creation aborted.')
      }
    }
    return organization
  }

  const user = await client.getUserInformation()
  const defaultOrganization = user.default_organization?.organization_name
  if (options.defaultOrg && defaultOrganization !== undefined && organizations.includes(defaultOrganization)) {
    return defaultOrganization
  }
  return await context.prompt.choice(
    '\nTo create and use a new project, please provide the following information:\nSelect the organization to create the project in',
    organizations,
    defaultOrganization ?? organizations[0]
  )
}

async function createProjectWithPrompt(
  client: LogfireApiClient,
  organization: string,
  projectName: string | undefined,
  context: CliContext
): Promise<ProjectTokenResponse> {
  const defaultName = sanitizeProjectName(basename(context.cwd))
  let promptMessage = 'Enter the project name'
  let currentProjectName = projectName

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loops until a name is accepted by the backend.
  while (true) {
    // eslint-disable-next-line no-await-in-loop -- the name prompt must resolve before attempting creation.
    currentProjectName = currentProjectName ?? (await context.prompt.text(promptMessage, defaultName))
    while (!PROJECT_NAME_PATTERN.test(currentProjectName)) {
      // eslint-disable-next-line no-await-in-loop -- reprompt sequentially until the name is valid.
      currentProjectName = await context.prompt.text(
        "\nThe project name you've entered is invalid. Valid project names:\n" +
          '  * may contain lowercase alphanumeric characters\n' +
          '  * may contain single hyphens\n' +
          '  * may not start or end with a hyphen\n\n' +
          'Enter the project name you want to use:',
        defaultName
      )
    }

    try {
      // eslint-disable-next-line no-await-in-loop -- each creation attempt must complete before retrying with a new name.
      return await client.createNewProject(organization, currentProjectName)
    } catch (error) {
      if (error instanceof ProjectAlreadyExistsError) {
        promptMessage = `\nA project with the name '${currentProjectName}' already exists. Please enter a different project name`
        currentProjectName = undefined
        continue
      }
      if (error instanceof InvalidProjectNameError) {
        promptMessage = `\nThe project name you entered is invalid:\n${error.reason}\nPlease enter a different project name`
        currentProjectName = undefined
        continue
      }
      throw error
    }
  }
}

async function selectProject(
  client: LogfireApiClient,
  options: Pick<ProjectCommandOptions, 'org' | 'projectName'>,
  context: CliContext
): Promise<WritableProject | undefined> {
  const projects = await client.getUserProjects()
  let filteredProjects = projects
  let organization = options.org
  let projectName = options.projectName
  let orgMessage = ''
  let orgFlag = ''
  let projectMessage = 'projects'

  if (organization !== undefined) {
    filteredProjects = filteredProjects.filter((project) => project.organization_name === organization)
    orgMessage = ` in organization \`${organization}\``
    orgFlag = ` --org ${organization}`
  }
  if (projectName !== undefined) {
    projectMessage = `projects with name \`${projectName}\``
    filteredProjects = filteredProjects.filter((project) => project.project_name === projectName)
  }

  if (projectName !== undefined && filteredProjects.length === 1) {
    const project = filteredProjects[0]
    if (project !== undefined) {
      return project
    }
  } else if (filteredProjects.length === 0) {
    if (projects.length === 0) {
      writeLine(context.stderr, 'No projects found for the current user. You can create a new project with `logfire projects new`')
      return undefined
    }
    const chooseAll = await context.prompt.confirm(
      `No ${projectMessage} found for the current user${orgMessage}. Choose from all projects?`,
      true
    )
    if (!chooseAll) {
      writeLine(context.stderr, `You can create a new project${orgMessage} with \`logfire projects new${orgFlag}\``)
      return undefined
    }
    filteredProjects = projects
    organization = undefined
    projectName = undefined
  } else {
    if (projectName !== undefined && organization === undefined) {
      writeLine(context.stderr, `Found multiple ${projectMessage}.`)
    }
    organization = undefined
    projectName = undefined
  }

  if (organization !== undefined && projectName !== undefined) {
    return { organization_name: organization, project_name: projectName }
  }

  const choices = filteredProjects.map((_, index) => String(index + 1))
  const choicesText = filteredProjects
    .map((project, index) => `${String(index + 1)}. ${project.organization_name}/${project.project_name}`)
    .join('\n')
  const selected = await context.prompt.choice(
    `Please select one of the following projects by number (requires the 'write_token' permission):\n${choicesText}\n`,
    choices,
    '1'
  )
  return filteredProjects[Number(selected) - 1]
}

function parseProjectOptions(args: string[]): ProjectCommandOptions {
  const options: ProjectCommandOptions = { defaultOrg: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (arg === '--data-dir') {
      options.dataDir = readRequiredValue(args, ++index, '--data-dir')
    } else if (arg.startsWith('--data-dir=')) {
      options.dataDir = arg.slice('--data-dir='.length)
    } else if (arg === '--org') {
      options.org = readRequiredValue(args, ++index, '--org')
    } else if (arg.startsWith('--org=')) {
      options.org = arg.slice('--org='.length)
    } else if (arg === '--default-org') {
      options.defaultOrg = true
    } else if (arg.startsWith('-')) {
      throw new LogfireCliError(`Unknown option ${arg}`)
    } else if (options.projectName === undefined) {
      options.projectName = arg
    } else {
      throw new LogfireCliError(`Unexpected argument ${arg}`)
    }
  }
  return options
}

function parseStatusOptions(args: string[]): StatusOptions {
  const options: StatusOptions = { json: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (arg === '--data-dir') {
      options.dataDir = readRequiredValue(args, ++index, '--data-dir')
    } else if (arg.startsWith('--data-dir=')) {
      options.dataDir = arg.slice('--data-dir='.length)
    } else if (arg === '--json') {
      options.json = true
    } else {
      throw new LogfireCliError(`Unexpected argument ${arg}`)
    }
  }
  return options
}

function readRequiredValue(args: string[], index: number, option: string): string {
  const value = args[index]
  if (value === undefined) {
    throw new LogfireCliError(`Missing value for ${option}`)
  }
  return value
}

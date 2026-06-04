import { basename } from 'node:path'

import { createAuthenticatedClient } from '../authClient'
import type { LogfireApiClient, ProjectTokenResponse, WritableProject } from '../client'
import { InvalidProjectNameError, ProjectAlreadyExistsError } from '../client'
import type { CliContext, GlobalOptions } from '../context'
import { defaultDataDir, writeProjectCredentials } from '../credentials'
import { LogfireCliError } from '../errors'
import { prettyTable, writeLine } from '../output'

const PROJECT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

interface ProjectCommandOptions {
  dataDir?: string
  defaultOrg: boolean
  org?: string
  projectName?: string
}

export async function runProjectsCommand(args: string[], globalOptions: GlobalOptions, context: CliContext): Promise<void> {
  const subcommand = args[0]
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    printProjectsHelp(context)
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
  writeLine(context.stdout, '  list   List projects')
  writeLine(context.stdout, '  new    Create a new project')
  writeLine(context.stdout, '  use    Use an existing project')
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

function readRequiredValue(args: string[], index: number, option: string): string {
  const value = args[index]
  if (value === undefined) {
    throw new LogfireCliError(`Missing value for ${option}`)
  }
  return value
}

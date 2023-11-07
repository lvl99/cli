import {AppErrors, isWebType} from './loader.js'
import {ExtensionInstance} from '../extensions/extension-instance.js'
import {isType} from '../../utilities/types.js'
import {FunctionConfigType} from '../extensions/specifications/function.js'
import {zod} from '@shopify/cli-kit/node/schema'
import {DotEnvFile} from '@shopify/cli-kit/node/dot-env'
import {getDependencies, PackageManager, readAndParsePackageJson} from '@shopify/cli-kit/node/node-package-manager'
import {fileRealPath, findPathUp} from '@shopify/cli-kit/node/fs'
import {joinPath} from '@shopify/cli-kit/node/path'
import {AbortError} from '@shopify/cli-kit/node/error'

export const LegacyAppSchema = zod
  .object({
    client_id: zod.number().optional(),
    name: zod.string().optional(),
    scopes: zod.string().default(''),
    extension_directories: zod.array(zod.string()).optional(),
    web_directories: zod.array(zod.string()).optional(),
  })
  .strict()

// adding http or https presence and absence of new lines to url validation
const validateUrl = (zodType: zod.ZodString, {httpsOnly = false, message = 'Invalid url'} = {}) => {
  const regex = httpsOnly ? /^(https:\/\/)/ : /^(https?:\/\/)/
  return zodType
    .url()
    .refine((value) => Boolean(value.match(regex)), {message})
    .refine((value) => !value.includes('\n'), {message})
}

const ensurePathStartsWithSlash = (arg: unknown) => (typeof arg === 'string' && !arg.startsWith('/') ? `/${arg}` : arg)
const ensureHttpsOnlyUrl = validateUrl(zod.string(), {
  httpsOnly: true,
  message: 'Only https urls are allowed',
}).refine((url) => !url.endsWith('/'), {message: 'URL can’t end with a forward slash'})

const SubscriptionEndpointUrlValidation = ensureHttpsOnlyUrl.optional()
const PubSubProjectValidation = zod.string().optional()
const PubSubTopicValidation = zod.string().optional()
// example Eventbridge ARN - arn:aws:events:us-west-2::event-source/aws.partner/shopify.com/1234567890/webhooks_path
const ArnValidation = zod
  .string()
  .regex(
    /^arn:aws:events:(?<aws_region>[a-z]{2}-[a-z]+-[0-9]+)::event-source\/aws\.partner\/shopify\.com(\.test)?\/(?<api_client_id>\d+)\/(?<event_source_name>.+)$/,
  )
  .optional()

export const WebhookSubscriptionSchema = zod.object({
  topic: zod.string(),
  sub_topic: zod.string().optional(),
  format: zod.enum(['json', 'xml']).optional(),
  include_fields: zod.array(zod.string()).optional(),
  metafield_namespaces: zod.array(zod.string()).optional(),
  subscription_endpoint_url: SubscriptionEndpointUrlValidation,
  path: zod
    .string()
    .refine((path) => path.startsWith('/') && path.length > 1, {
      message: 'Path must start with a forward slash and be longer than 1 character',
    })
    .optional(),
  pubsub_project: PubSubProjectValidation,
  pubsub_topic: PubSubTopicValidation,
  arn: ArnValidation,
})

const WebhooksSchema = zod
  .object({
    api_version: zod.string(),
    privacy_compliance: zod
      .object({
        customer_deletion_url: ensureHttpsOnlyUrl.optional(),
        customer_data_request_url: ensureHttpsOnlyUrl.optional(),
        shop_deletion_url: ensureHttpsOnlyUrl.optional(),
      })
      .optional(),
    subscription_endpoint_url: SubscriptionEndpointUrlValidation,
    pubsub_project: PubSubProjectValidation,
    pubsub_topic: PubSubTopicValidation,
    arn: ArnValidation,
    topics: zod.array(zod.string()).nonempty().optional(),
    subscriptions: zod.array(WebhookSubscriptionSchema).optional(),
  })
  .superRefine(
    // eslint-disable-next-line @typescript-eslint/naming-convention
    ({subscription_endpoint_url, pubsub_project, pubsub_topic, arn, topics = [], subscriptions = []}, ctx) => {
      const topLevelDestinations = [subscription_endpoint_url, pubsub_project && pubsub_topic, arn].filter(Boolean)
      const getFullPubSubValidationError = (suffix: string) =>
        `You must declare both pubsub_project and pubsub_topic if you wish to use ${suffix}`
      const getTooManyDesignationsError = (suffix: string) =>
        `You are only allowed to declare one (1) of subscription_endpoint_url, pubsub_project & pubsub_topic, or arn ${suffix}`

      if ([pubsub_project, pubsub_topic].filter(Boolean).length === 1) {
        ctx.addIssue({
          code: zod.ZodIssueCode.custom,
          message: getFullPubSubValidationError('a top-level pub sub destination'),
          fatal: true,
        })
        return zod.NEVER
      }

      if (topLevelDestinations.length > 1) {
        ctx.addIssue({
          code: zod.ZodIssueCode.custom,
          message: getTooManyDesignationsError('at the top level'),
          fatal: true,
        })
        return zod.NEVER
      }

      if (topLevelDestinations.length && !topics.length && !subscriptions.length) {
        ctx.addIssue({
          code: zod.ZodIssueCode.custom,
          message:
            'To use a top-level destination, you must also provide a `topics` array or `subscriptions` configuration',
          fatal: true,
        })
        return zod.NEVER
      }

      if (!topLevelDestinations.length && topics.length) {
        ctx.addIssue({
          code: zod.ZodIssueCode.custom,
          message:
            'To use top-level topics, you must also provide a top-level destination of either subscription_endpoint_url, pubsub_project & pubsub_topic, or arn',
          fatal: true,
          path: ['topics'],
        })
        return zod.NEVER
      }

      // a unique subscription URI is keyed on `${topic}::${destinationURI}`
      const delimiter = '::'
      const topLevelDestination = [subscription_endpoint_url, pubsub_project, pubsub_topic, arn]
        .filter(Boolean)
        .join(delimiter)
      const subscriptionDestinationsSet = new Set()

      // if we have a top level destination and top level topics, add them
      if (topLevelDestination && topics.length) {
        for (const topic of topics) {
          const key = `${topic}${delimiter}${topLevelDestination}`

          if (subscriptionDestinationsSet.has(key)) {
            ctx.addIssue({
              code: zod.ZodIssueCode.custom,
              message: 'You can’t have duplicate subscriptions with the exact same topic and destination',
              fatal: true,
              path: ['topics', topic],
            })
            return zod.NEVER
          }

          subscriptionDestinationsSet.add(key)
        }
      }

      // validate individual subscriptions
      if (subscriptions.length) {
        for (const [i, subscription] of subscriptions.entries()) {
          const subscriptionDestinations = [
            subscription.subscription_endpoint_url,
            subscription.pubsub_project && subscription.pubsub_topic,
            subscription.arn,
          ].filter(Boolean)
          const path = ['subscriptions', i]

          if ([subscription.pubsub_project, subscription.pubsub_topic].filter(Boolean).length === 1) {
            ctx.addIssue({
              code: zod.ZodIssueCode.custom,
              message: getFullPubSubValidationError('a pub sub destination'),
              fatal: true,
              path,
            })
            return zod.NEVER
          }

          if (subscriptionDestinations.length > 1) {
            ctx.addIssue({
              code: zod.ZodIssueCode.custom,
              message: getTooManyDesignationsError('per subscription'),
              fatal: true,
              path,
            })
            return zod.NEVER
          }

          // If no top-level destinations are provided, ensure each subscription has at least one destination
          if (!topLevelDestinations.length && subscriptionDestinations.length === 0) {
            ctx.addIssue({
              code: zod.ZodIssueCode.custom,
              message: 'You must declare either a top-level destination or a destination per subscription',
              fatal: true,
              path,
            })
            return zod.NEVER
          }

          if (!subscription_endpoint_url && !subscription.subscription_endpoint_url && subscription.path) {
            ctx.addIssue({
              code: zod.ZodIssueCode.custom,
              message: 'You must declare a subscription_endpoint_url if you wish to use a relative path',
              fatal: true,
              path,
            })
            return zod.NEVER
          }

          if ((subscription.arn || subscription.pubsub_project) && subscription.path) {
            ctx.addIssue({
              code: zod.ZodIssueCode.custom,
              message: 'You can’t define a path when using arn or pubsub',
              fatal: true,
              path,
            })
            return zod.NEVER
          }

          let destination = [
            subscription.subscription_endpoint_url,
            subscription.pubsub_project,
            subscription.pubsub_topic,
            subscription.arn,
          ]
            .filter(Boolean)
            .join(delimiter)

          // if there is no destination override, use top level destination
          if (!destination) {
            destination = topLevelDestination
          }

          // concat the path to the destination if it exists to ensure uniqueness
          if (subscription.path) {
            destination = `${destination}${subscription.path}`
          }

          const key = `${subscription.topic}${delimiter}${destination}`

          if (subscriptionDestinationsSet.has(key)) {
            ctx.addIssue({
              code: zod.ZodIssueCode.custom,
              message: 'You can’t have duplicate subscriptions with the exact same topic and destination',
              fatal: true,
              path: [...path, subscription.topic],
            })
            return zod.NEVER
          }

          subscriptionDestinationsSet.add(key)
        }
      }
    },
  )

export const AppSchema = zod
  .object({
    name: zod.string().max(30),
    client_id: zod.string(),
    application_url: validateUrl(zod.string()),
    embedded: zod.boolean(),
    access_scopes: zod
      .object({
        scopes: zod.string().optional(),
        use_legacy_install_flow: zod.boolean().optional(),
      })
      .optional(),
    auth: zod
      .object({
        redirect_urls: zod.array(validateUrl(zod.string())),
      })
      .optional(),
    webhooks: WebhooksSchema,
    app_proxy: zod
      .object({
        url: validateUrl(zod.string()),
        subpath: zod.string(),
        prefix: zod.string(),
      })
      .optional(),
    pos: zod
      .object({
        embedded: zod.boolean(),
      })
      .optional(),
    app_preferences: zod
      .object({
        url: validateUrl(zod.string().max(255)),
      })
      .optional(),
    build: zod
      .object({
        automatically_update_urls_on_dev: zod.boolean().optional(),
        dev_store_url: zod.string().optional(),
      })
      .optional(),
    extension_directories: zod.array(zod.string()).optional(),
    web_directories: zod.array(zod.string()).optional(),
  })
  .strict()

export const AppConfigurationSchema = zod.union([LegacyAppSchema, AppSchema])

/**
 * Check whether a shopify.app.toml schema is valid against the legacy schema definition.
 * @param item - the item to validate
 */
export function isLegacyAppSchema(item: AppConfiguration): item is LegacyAppConfiguration {
  const {path, ...rest} = item
  return isType(LegacyAppSchema, rest)
}

/**
 * Check whether a shopify.app.toml schema is valid against the current schema definition.
 * @param item - the item to validate
 */
export function isCurrentAppSchema(item: AppConfiguration): item is CurrentAppConfiguration {
  const {path, ...rest} = item
  return isType(AppSchema, rest)
}

/**
 * Get scopes from a given app.toml config file.
 * @param config - a configuration file
 */
export function getAppScopes(config: AppConfiguration) {
  if (isLegacyAppSchema(config)) {
    return config.scopes
  } else {
    return config.access_scopes?.scopes ?? ''
  }
}

/**
 * Get scopes as an array from a given app.toml config file.
 * @param config - a configuration file
 */
export function getAppScopesArray(config: AppConfiguration) {
  const scopes = getAppScopes(config)
  return scopes.length ? scopes.split(',').map((scope) => scope.trim()) : []
}

export function usesLegacyScopesBehavior(config: AppConfiguration) {
  if (isLegacyAppSchema(config)) return true
  return Boolean(config.access_scopes?.use_legacy_install_flow)
}

export function appIsLaunchable(app: AppInterface) {
  const frontendConfig = app?.webs?.find((web) => isWebType(web, WebType.Frontend))
  const backendConfig = app?.webs?.find((web) => isWebType(web, WebType.Backend))

  return Boolean(frontendConfig || backendConfig)
}

export enum WebType {
  Frontend = 'frontend',
  Backend = 'backend',
  Background = 'background',
}

const WebConfigurationAuthCallbackPathSchema = zod.preprocess(ensurePathStartsWithSlash, zod.string())

const baseWebConfigurationSchema = zod.object({
  auth_callback_path: zod
    .union([WebConfigurationAuthCallbackPathSchema, WebConfigurationAuthCallbackPathSchema.array()])
    .optional(),
  webhooks_path: zod.preprocess(ensurePathStartsWithSlash, zod.string()).optional(),
  port: zod.number().max(65536).min(0).optional(),
  commands: zod.object({
    build: zod.string().optional(),
    dev: zod.string(),
  }),
  name: zod.string().optional(),
  hmr_server: zod.object({http_paths: zod.string().array()}).optional(),
})
const webTypes = zod.enum([WebType.Frontend, WebType.Backend, WebType.Background]).default(WebType.Frontend)
export const WebConfigurationSchema = zod.union([
  baseWebConfigurationSchema.extend({roles: zod.array(webTypes)}),
  baseWebConfigurationSchema.extend({type: webTypes}),
])
export const ProcessedWebConfigurationSchema = baseWebConfigurationSchema.extend({roles: zod.array(webTypes)})

export type AppConfiguration = zod.infer<typeof AppConfigurationSchema> & {path: string}
export type CurrentAppConfiguration = zod.infer<typeof AppSchema> & {path: string}
export type LegacyAppConfiguration = zod.infer<typeof LegacyAppSchema> & {path: string}
export type WebConfiguration = zod.infer<typeof WebConfigurationSchema>
export type ProcessedWebConfiguration = zod.infer<typeof ProcessedWebConfigurationSchema>
export type WebConfigurationCommands = keyof WebConfiguration['commands']
export type WebhookConfig = Partial<zod.infer<typeof AppSchema>['webhooks']>

export interface Web {
  directory: string
  configuration: ProcessedWebConfiguration
  framework?: string
}

export interface AppConfigurationInterface {
  directory: string
  configuration: AppConfiguration
}

export interface AppInterface extends AppConfigurationInterface {
  name: string
  idEnvironmentVariableName: string
  packageManager: PackageManager
  nodeDependencies: {[key: string]: string}
  webs: Web[]
  usesWorkspaces: boolean
  dotenv?: DotEnvFile
  allExtensions: ExtensionInstance[]
  errors?: AppErrors
  hasExtensions: () => boolean
  updateDependencies: () => Promise<void>
  extensionsForType: (spec: {identifier: string; externalIdentifier: string}) => ExtensionInstance[]
  updateExtensionUUIDS: (uuids: {[key: string]: string}) => void
  preDeployValidation: () => Promise<void>
}

export class App implements AppInterface {
  name: string
  idEnvironmentVariableName: string
  directory: string
  packageManager: PackageManager
  configuration: AppConfiguration
  nodeDependencies: {[key: string]: string}
  webs: Web[]
  usesWorkspaces: boolean
  dotenv?: DotEnvFile
  errors?: AppErrors
  allExtensions: ExtensionInstance[]

  // eslint-disable-next-line max-params
  constructor(
    name: string,
    idEnvironmentVariableName: string,
    directory: string,
    packageManager: PackageManager,
    configuration: AppConfiguration,
    nodeDependencies: {[key: string]: string},
    webs: Web[],
    extensions: ExtensionInstance[],
    usesWorkspaces: boolean,
    dotenv?: DotEnvFile,
    errors?: AppErrors,
  ) {
    this.name = name
    this.idEnvironmentVariableName = idEnvironmentVariableName
    this.directory = directory
    this.packageManager = packageManager
    this.configuration = configuration
    this.nodeDependencies = nodeDependencies
    this.webs = webs
    this.dotenv = dotenv
    this.allExtensions = extensions
    this.errors = errors
    this.usesWorkspaces = usesWorkspaces
  }

  async updateDependencies() {
    const nodeDependencies = await getDependencies(joinPath(this.directory, 'package.json'))
    this.nodeDependencies = nodeDependencies
  }

  async preDeployValidation() {
    const functionExtensionsWithUiHandle = this.allExtensions.filter(
      (ext) => ext.isFunctionExtension && (ext.configuration as unknown as FunctionConfigType).ui?.handle,
    ) as ExtensionInstance<FunctionConfigType>[]

    if (functionExtensionsWithUiHandle.length > 0) {
      const errors = validateFunctionExtensionsWithUiHandle(functionExtensionsWithUiHandle, this.allExtensions)
      if (errors) {
        throw new AbortError('Invalid function configuration', errors.join('\n'))
      }
    }

    await Promise.all([this.allExtensions.map((ext) => ext.preDeployValidation())])
  }

  hasExtensions(): boolean {
    return this.allExtensions.length > 0
  }

  extensionsForType(specification: {identifier: string; externalIdentifier: string}): ExtensionInstance[] {
    return this.allExtensions.filter(
      (extension) => extension.type === specification.identifier || extension.type === specification.externalIdentifier,
    )
  }

  updateExtensionUUIDS(uuids: {[key: string]: string}) {
    this.allExtensions.forEach((extension) => {
      extension.devUUID = uuids[extension.localIdentifier] ?? extension.devUUID
    })
  }
}

export function validateFunctionExtensionsWithUiHandle(
  functionExtensionsWithUiHandle: ExtensionInstance<FunctionConfigType>[],
  allExtensions: ExtensionInstance[],
): string[] | undefined {
  const errors: string[] = []

  functionExtensionsWithUiHandle.forEach((extension) => {
    const uiHandle = extension.configuration.ui!.handle!

    const matchingExtension = findExtensionByHandle(allExtensions, uiHandle)
    if (!matchingExtension) {
      errors.push(`[${extension.name}] - Local app must contain a ui_extension with handle '${uiHandle}'`)
    } else if (matchingExtension.configuration.type !== 'ui_extension') {
      errors.push(
        `[${extension.name}] - Local app must contain one extension of type 'ui_extension' and handle '${uiHandle}'`,
      )
    }
  })

  return errors.length > 0 ? errors : undefined
}

function findExtensionByHandle(allExtensions: ExtensionInstance[], handle: string): ExtensionInstance | undefined {
  return allExtensions.find((ext) => ext.handle === handle)
}

export class EmptyApp extends App {
  constructor() {
    const configuration = {scopes: '', extension_directories: [], path: ''}
    super('', '', '', 'npm', configuration, {}, [], [], false)
  }
}

type RendererVersionResult = {name: string; version: string} | undefined | 'not_found'

/**
 * Given a UI extension, it returns the version of the renderer package.
 * Looks for `/node_modules/@shopify/{renderer-package-name}/package.json` to find the real version used.
 * @param extension - UI extension whose renderer version will be obtained.
 * @returns The version if the dependency exists.
 */
export async function getUIExtensionRendererVersion(extension: ExtensionInstance): Promise<RendererVersionResult> {
  // Look for the vanilla JS version of the dependency (the react one depends on it, will always be present)
  const rendererDependency = extension.dependency
  if (!rendererDependency) return undefined
  return getDependencyVersion(rendererDependency, extension.directory)
}

export async function getDependencyVersion(dependency: string, directory: string): Promise<RendererVersionResult> {
  // Split the dependency name to avoid using "/" in windows. Only look for non react dependencies.
  const dependencyName = dependency.replace('-react', '').split('/')
  const pattern = joinPath('node_modules', dependencyName[0]!, dependencyName[1]!, 'package.json')

  let packagePath = await findPathUp(pattern, {
    cwd: directory,
    type: 'file',
    allowSymlinks: true,
  })
  if (!packagePath) return 'not_found'
  packagePath = await fileRealPath(packagePath)

  // Load the package.json and extract the version
  const packageContent = await readAndParsePackageJson(packagePath)
  if (!packageContent.version) return 'not_found'
  return {name: dependency, version: packageContent.version}
}

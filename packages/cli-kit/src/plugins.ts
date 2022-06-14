import {join, pathToFileURL} from './path'
import {Plugin} from '@oclif/core/lib/interfaces'

const TUNNEL_PLUGINS = ['@shopify/plugin-ngrok']

interface TunnelPlugin {
  start: (options: TunnelStartOptions) => Promise<string>
}

interface TunnelStartOptions {
  port: number
}

export async function lookupTunnelPlugin(plugins: Plugin[]): Promise<TunnelPlugin | undefined> {
  const tunnelPlugin = plugins.find((plugin) => TUNNEL_PLUGINS.includes(plugin.name))
  if (!tunnelPlugin) return undefined
  const tunnelPath = pathToFileURL(join(tunnelPlugin.root, 'dist/tunnel.js')).toString()
  return import(tunnelPath).catch(() => undefined)
}

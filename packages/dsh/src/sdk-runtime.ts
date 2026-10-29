import { createRequire } from 'node:module'

interface HostSdk {
  credentials: typeof import('@deepseek-ai/dsh-credentials')
  launchEnvironment: typeof import('@deepseek-ai/dsh-launch-environment')
  llm: typeof import('@deepseek-ai/dsh-llm')
  session: typeof import('@deepseek-ai/dsh-session')
}

// Installing or inspecting the plugin does not need a host. Resolve SDKs only
// when running, through Node's resolver and the DSH host's shared-module hooks.
export const createHostSdk = (requireModule: (name: string) => unknown): HostSdk => {
  const modules = new Map<string, unknown>()
  const load = <T>(name: string): T => {
    if (!modules.has(name)) modules.set(name, requireModule(name))
    return modules.get(name) as T
  }
  return {
    get credentials() { return load<HostSdk['credentials']>('@deepseek-ai/dsh-credentials') },
    get launchEnvironment() { return load<HostSdk['launchEnvironment']>('@deepseek-ai/dsh-launch-environment') },
    get llm() { return load<HostSdk['llm']>('@deepseek-ai/dsh-llm') },
    get session() { return load<HostSdk['session']>('@deepseek-ai/dsh-session') },
  }
}

export const hostSdk = createHostSdk(createRequire(import.meta.url))

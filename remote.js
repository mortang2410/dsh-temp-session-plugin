/**
 * Hand-written Typert descriptors for the `tempSession` Remote namespace.
 *
 * A standalone bundle has no generated `/remote` artifact, so the Host vendor
 * contribution and the browser contribution are declared here (the browser
 * module repeats the same codecs; it cannot import this file). The codecs are
 * strict: the Gateway calls `codec.create().parse(value)` and uses the parsed
 * value as the parameter.
 *
 * @module dsh-temp-session-plugin/remote
 */

/** One strict codec without a Zod dependency. */
const strict = (name, parse) => ({
  mode: 'strict',
  typeSymbol: `dsh-temp-session-plugin#${name}`,
  create: () => ({ parse }),
})

/** Validate a request naming one Session. */
const sessionRequest = strict('SessionRequest', (value) => {
  if (value === null || typeof value !== 'object' || typeof value.sessionId !== 'string' || value.sessionId === '') {
    throw new Error('temporary session requests require a non-empty sessionId')
  }
  return { sessionId: value.sessionId }
})

/** Validate a registration request and its optional display title. */
const registerRequest = strict('RegisterRequest', (value) => {
  const base = sessionRequest.create().parse(value)
  return { ...base, title: typeof value.title === 'string' ? value.title : '' }
})

/** Validate a registration result. */
const registerResult = strict('RegisterResult', (value) => {
  if (value === null
    || typeof value !== 'object'
    || typeof value.sessionId !== 'string'
    || !Number.isSafeInteger(value.createdAt)) {
    throw new Error('temporary session registration returned an invalid record')
  }
  return { sessionId: value.sessionId, createdAt: value.createdAt }
})

/** Validate one listed record. */
const listedRecord = strict('ListedRecord', (value) => {
  const parsed = registerResult.create().parse(value)
  return { sessionId: parsed.sessionId, createdAt: parsed.createdAt }
})

/** Validate a listing result. */
const listResult = strict('ListResult', (value) => {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.sessions)) {
    throw new Error('temporary session listing returned an invalid payload')
  }
  return { sessions: value.sessions.map(item => listedRecord.create().parse(item)) }
})

/** Validate a discard result. */
const discardResult = strict('DiscardResult', (value) => {
  if (value === null || typeof value !== 'object' || value.discarded !== true) {
    throw new Error('temporary session discard returned an invalid receipt')
  }
  return { discarded: true }
})

/** Method descriptors shared by the Host contribution and the browser mount. */
export const tempSessionDescriptors = [
  {
    id: 'dsh-temp-session-plugin#tempSession/register',
    service: 'tempSessionsHost',
    namespace: 'tempSession',
    method: 'register',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: registerRequest }],
    result: registerResult,
  },
  {
    id: 'dsh-temp-session-plugin#tempSession/list',
    service: 'tempSessionsHost',
    namespace: 'tempSession',
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [],
    result: listResult,
  },
  {
    id: 'dsh-temp-session-plugin#tempSession/discard',
    service: 'tempSessionsHost',
    namespace: 'tempSession',
    method: 'discard',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: sessionRequest }],
    result: discardResult,
  },
]

/** Host-visible vendor contribution registered through `ctx.typert.register`. */
export const tempSessionContribution = {
  package: 'dsh-temp-session-plugin',
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: tempSessionDescriptors,
}

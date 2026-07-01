const unwrapSymbol: unique symbol = Symbol('unwrap')

type Wrapped<T> = { [unwrapSymbol]: T } & T

export function isWrapped<T>(item: T): item is Wrapped<T> {
  return item !== null && item !== undefined && Boolean((item as Wrapped<T>)[unwrapSymbol])
}

export function isProxyable(item: unknown): boolean {
  return (item !== null && typeof item === 'object') || typeof item === 'function'
}

export function wrap<T extends object>(item: T, handler: ProxyHandler<T>, autoPassthrough: boolean = true): T {
  if (isWrapped(item) || !isProxyable(item)) {
    return item
  }
  const proxyHandler = { ...handler }
  proxyHandler.get = (target, prop, receiver) => {
    if (prop === unwrapSymbol) {
      return item
    } else if (handler.get !== undefined) {
      return handler.get(target, prop, receiver)
    } else if (prop === 'bind') {
      return () => receiver
    } else if (autoPassthrough) {
      return passthroughGet(target, prop)
    }
    return undefined
  }
  proxyHandler.apply = (target, thisArg, argArray) => {
    if (handler.apply !== undefined) {
      return handler.apply(unwrap(target), unwrap(thisArg), argArray)
    }
    return undefined
  }
  return new Proxy(item, proxyHandler)
}

export function unwrap<T extends object>(item: T): T {
  if (item && isWrapped(item)) {
    return item[unwrapSymbol]
  } else {
    return item
  }
}

export function passthroughGet(target: object, prop: string | symbol, thisArg?: object): unknown {
  const unwrappedTarget = unwrap(target)
  const value = Reflect.get(unwrappedTarget, prop)
  if (typeof value === 'function') {
    if (value.constructor.name === 'RpcProperty') {
      return (...args: unknown[]) => (Reflect.get(unwrappedTarget, prop) as (...args: unknown[]) => unknown)(...args)
    }
    thisArg = thisArg ?? unwrappedTarget
    return value.bind(thisArg)
  } else {
    return value
  }
}

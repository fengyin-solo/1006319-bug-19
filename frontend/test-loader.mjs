import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const srcRoot = path.resolve('./src')

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    return { url: pathToFileURL(path.join(srcRoot, specifier.slice(2)) + '.ts').href, shortCircuit: true }
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {
    const base = new URL(context.parentURL).pathname
    return { url: pathToFileURL(path.resolve(path.dirname(base), specifier + '.ts')).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file://') && url.endsWith('.ts')) {
    const filePath = new URL(url).pathname
    const source = readFileSync(filePath, 'utf8')
    const { code } = transformSync(source, { loader: 'ts', format: 'esm' })
    return { format: 'module', shortCircuit: true, source: code }
  }
  return nextLoad(url, context)
}

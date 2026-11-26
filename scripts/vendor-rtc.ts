// Vendors tinyrtc into the `rtc` plugin: the Swift and Kotlin SOURCES of its platform halves and the
// prebuilt Rust core (an xcframework for iOS, the JNI library per ABI for Android). tinyrtc is a
// repository of its own with no LeCodes in it; the plugin carries a copy pinned to one of its
// commits, so an app build needs neither that repository nor a Rust toolchain.
//
//   bun scripts/vendor-rtc.ts            rewrite the copies from a tinyrtc checkout
//   bun scripts/vendor-rtc.ts --check    fail when a copy differs from what was vendored
//
// The checkout: $TINYRTC, else ../../../tinyrtc (a sibling of the core repository). It must be
// clean, and its build outputs must be of that commit — they are not in its git:
//   apple/TinyRTCCore.xcframework                           apple/build-core.sh, on a Mac
//   android/tinyrtc/build/outputs/aar/tinyrtc-release.aar   android/build-core.sh, then
//                                                           ./gradlew :tinyrtc:assembleRelease
//
// Direction of flow: tinyrtc -> these copies. Never edit a copy: `--check` compares every file
// with the hash written at vendoring (plugins/rtc/tinyrtc.lock.json) and needs no checkout for it.
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { inflateRawSync } from "node:zlib"
import { join, relative } from "node:path"
import { execSync } from "node:child_process"

const repo = join(import.meta.dir, "..")
const plugin = join(repo, "plugins", "rtc")
const lockPath = join(plugin, "tinyrtc.lock.json")
const ABIS = ["arm64-v8a", "armeabi-v7a"]

/** The folders this script owns inside the plugin: everything in them is a copy. */
const OWNED = [
  "ios/tinyrtc",
  "binaries/ios/TinyRTCCore.xcframework",
  "android/src/main/java/dev/tinyrtc",
  "android/src/main/jniLibs",
  "android/consumer-rules.pro",
]

interface Lock { commit: string, files: Record<string, string> }

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

function walk(path: string): string[] {
  if (!existsSync(path)) return []
  if (statSync(path).isFile()) return [path]
  return readdirSync(path).sort().flatMap(name => walk(join(path, name)))
}

const owned = () => OWNED.flatMap(part => walk(join(plugin, part))).map(file => relative(plugin, file).replaceAll("\\", "/"))

function check(): never {
  if (!existsSync(lockPath)) {
    console.error("vendor-rtc: plugins/rtc/tinyrtc.lock.json is missing — run `bun scripts/vendor-rtc.ts`")
    process.exit(1)
  }
  const lock: Lock = JSON.parse(readFileSync(lockPath, "utf8"))
  const present = new Set(owned())
  const problems: string[] = []
  for (const [file, hash] of Object.entries(lock.files)) {
    if (!present.has(file)) problems.push(`missing   ${file}`)
    else if (sha256(join(plugin, file)) !== hash) problems.push(`edited    ${file}`)
    present.delete(file)
  }
  for (const file of present) problems.push(`not ours  ${file}`)
  if (problems.length) {
    console.error(`vendor-rtc: the copies of tinyrtc @ ${lock.commit.slice(0, 12)} were touched:\n  ${problems.join("\n  ")}`)
    process.exit(1)
  }
  console.log(`vendor-rtc: ${Object.keys(lock.files).length} files of tinyrtc @ ${lock.commit.slice(0, 12)}, untouched`)
  process.exit(0)
}

if (process.argv.includes("--check")) check()

const tinyrtc = process.env.TINYRTC ?? join(repo, "..", "..", "..", "tinyrtc")
if (!existsSync(join(tinyrtc, "core", "include", "tinyrtc.h"))) {
  console.error(`vendor-rtc: no tinyrtc checkout at ${tinyrtc} (set TINYRTC)`)
  process.exit(1)
}
const git = (args: string) => execSync(`git ${args}`, { cwd: tinyrtc, encoding: "utf8" }).trim()
if (git("status --porcelain") !== "") {
  console.error("vendor-rtc: the tinyrtc checkout has uncommitted changes — a copy must be of a commit")
  process.exit(1)
}
const commit = git("rev-parse HEAD")

const xcframework = join(tinyrtc, "apple", "TinyRTCCore.xcframework")
const aar = join(tinyrtc, "android", "tinyrtc", "build", "outputs", "aar", "tinyrtc-release.aar")
for (const [what, path] of [["the xcframework (apple/build-core.sh on a Mac)", xcframework], ["the AAR (./gradlew :tinyrtc:assembleRelease)", aar]]) {
  if (!existsSync(path)) {
    console.error(`vendor-rtc: ${what} is not built: ${path}`)
    process.exit(1)
  }
}
// The header inside the xcframework is the build's: a core built from another commit shows here.
const header = join(tinyrtc, "core", "include", "tinyrtc.h")
for (const slice of ["ios-arm64", "ios-arm64-simulator"]) {
  const built = join(xcframework, slice, "Headers", "TinyRTCCore", "tinyrtc.h")
  if (!existsSync(built) || sha256(built) !== sha256(header)) {
    console.error(`vendor-rtc: the xcframework's ${slice} header is not this commit's tinyrtc.h — rebuild it`)
    process.exit(1)
  }
}

for (const part of OWNED) rmSync(join(plugin, part), { recursive: true, force: true })

const copyAll = (from: string, to: string, ext: string) => {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from).sort()) if (name.endsWith(ext)) cpSync(join(from, name), join(to, name))
}
copyAll(join(tinyrtc, "apple", "Sources", "TinyRTC"), join(plugin, "ios", "tinyrtc"), ".swift")
copyAll(join(tinyrtc, "android", "tinyrtc", "src", "main", "kotlin", "dev", "tinyrtc"), join(plugin, "android", "src", "main", "java", "dev", "tinyrtc"), ".kt")
cpSync(xcframework, join(plugin, "binaries", "ios", "TinyRTCCore.xcframework"), { recursive: true })
cpSync(join(tinyrtc, "android", "tinyrtc", "consumer-rules.pro"), join(plugin, "android", "consumer-rules.pro"))

// The JNI libraries out of the AAR (a zip): the one place the stripped, packaged .so files are.
// Read here, with no tool: the central directory, then each entry stored or deflated.
function unzipEntry(zip: Buffer, name: string): Buffer {
  let end = zip.length - 22
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0) throw new Error("not a zip")
  let at = zip.readUInt32LE(end + 16)
  for (let left = zip.readUInt16LE(end + 10); left > 0; left--) {
    const method = zip.readUInt16LE(at + 10)
    const packed = zip.readUInt32LE(at + 20)
    const nameLen = zip.readUInt16LE(at + 28)
    const skip = zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
    const local = zip.readUInt32LE(at + 42)
    if (zip.toString("utf8", at + 46, at + 46 + nameLen) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      const data = zip.subarray(start, start + packed)
      return method === 0 ? Buffer.from(data) : inflateRawSync(data)
    }
    at += 46 + nameLen + skip
  }
  throw new Error(`${name} is not in the AAR`)
}
const archive = readFileSync(aar)
for (const abi of ABIS) {
  const to = join(plugin, "android", "src", "main", "jniLibs", abi)
  mkdirSync(to, { recursive: true })
  writeFileSync(join(to, "libtinyrtc_jni.so"), unzipEntry(archive, `jni/${abi}/libtinyrtc_jni.so`))
}

const files: Record<string, string> = {}
for (const file of owned()) files[file] = sha256(join(plugin, file))
const lock: Lock = { commit, files }
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n")
const bytes = Object.keys(files).reduce((sum, file) => sum + statSync(join(plugin, file)).size, 0)
console.log(`vendor-rtc: ${Object.keys(files).length} files (${(bytes / 1e6).toFixed(1)} MB) of tinyrtc @ ${commit.slice(0, 12)}`)

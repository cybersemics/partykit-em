import fs from "node:fs"
import readline from "node:readline"

const LINES_PER_FILE = 1_000_000
const HEADER = "PRAGMA foreign_keys = OFF;\nBEGIN TRANSACTION;\n"
const FOOTER = "COMMIT;\n"

async function splitFile(filename: string) {
  const fileStream = fs.createReadStream(filename)
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Number.POSITIVE_INFINITY,
  })

  let fileIndex = 0
  let lineCount = 0
  let currentWriteStream = null

  for await (const line of rl) {
    if (lineCount % LINES_PER_FILE === 0) {
      // Close previous file if exists
      if (currentWriteStream) {
        currentWriteStream.write(FOOTER)
        currentWriteStream.end()
      }

      // Create new file
      const outPath = `dump_part_${String(fileIndex).padStart(3, "0")}.sql`
      currentWriteStream = fs.createWriteStream(outPath)
      currentWriteStream.write(HEADER)
      fileIndex++
      console.log(`Creating ${outPath}`)
    }

    // biome-ignore lint/style/noNonNullAssertion: <explanation>
    currentWriteStream!.write(`${line}\n`)
    lineCount++
  }

  // Close the last file
  if (currentWriteStream) {
    currentWriteStream.write(FOOTER)
    currentWriteStream.end()
  }
}

// Run the script
splitFile("./1m-safe.dump").catch(console.error)

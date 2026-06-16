import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = path.resolve(__dirname, '../../../storage')

export class ArtifactService {
  static getArtifactPath(workspaceId: string, featureId: string, filename: string): string {
    return path.join(STORAGE_ROOT, workspaceId, featureId, filename)
  }

  static readArtifact(workspaceId: string, featureId: string, filename: string): string | null {
    const filePath = this.getArtifactPath(workspaceId, featureId, filename)
    if (!fs.existsSync(filePath)) return null
    return fs.readFileSync(filePath, 'utf-8')
  }

  static listArtifacts(workspaceId: string, featureId: string): string[] {
    const dir = path.join(STORAGE_ROOT, workspaceId, featureId)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
  }
}

import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = path.resolve(__dirname, '../../../storage')

// Implements: docs/adr/0001-workflow-execution-model.md (P2)
// 路径约定：storage/<workspaceId>/<featureId>/<nodeId>/<outputName>
export class ArtifactService {
  static getArtifactPath(workspaceId: string, featureId: string, nodeId: string, outputName: string): string {
    return path.join(STORAGE_ROOT, workspaceId, featureId, nodeId, outputName)
  }

  static readArtifact(workspaceId: string, featureId: string, nodeId: string, outputName: string): string | null {
    const filePath = this.getArtifactPath(workspaceId, featureId, nodeId, outputName)
    if (!fs.existsSync(filePath)) return null
    return fs.readFileSync(filePath, 'utf-8')
  }

  static listArtifacts(workspaceId: string, featureId: string): string[] {
    const dir = path.join(STORAGE_ROOT, workspaceId, featureId)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
  }
}

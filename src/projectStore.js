import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class ProjectStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        project_json TEXT NOT NULL
      )
    `);
  }

  saveProject(project) {
    const now = project.updatedAt || new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO projects (id, title, status, created_at, updated_at, project_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        updated_at = excluded.updated_at,
        project_json = excluded.project_json
    `);
    statement.run(
      project.id,
      project.title || project.brief?.title || "Untitled draft",
      project.status || "draft",
      project.createdAt || now,
      now,
      JSON.stringify(project),
    );
    return project;
  }

  getProject(id) {
    const row = this.db.prepare("SELECT project_json FROM projects WHERE id = ?").get(id);
    return row ? JSON.parse(row.project_json) : null;
  }

  listProjects() {
    const rows = this.db.prepare("SELECT id, title, status, created_at, updated_at, project_json FROM projects ORDER BY updated_at DESC").all();
    return rows.map((row) => {
      const project = JSON.parse(row.project_json);
      const scenes = project.storyboard?.scenes || [];
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        duration: project.storyboard?.duration || project.confirmation?.duration || 0,
        sceneCount: scenes.length,
        shotCount: scenes.flatMap((scene) => scene.shots || []).length,
        rendered: project.render?.status === "complete",
      };
    });
  }

  deleteProject(id) {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  close() {
    this.db.close();
  }
}

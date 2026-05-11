import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import type { Task, TaskSubmission } from "./types.js";

const TASK_KIND = "task_v2";
const SUBMISSION_KIND = "submission_v2";

export class WorkRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async saveTask(task: Task): Promise<void> {
    await this.store.saveProjection(TASK_KIND, task.id, task);
  }

  async getTask(id: string): Promise<Task | undefined> {
    return this.store.getProjection<Task>(TASK_KIND, id);
  }

  async listTasks(organizationId?: string): Promise<Task[]> {
    const all = await this.store.listProjections<Task>(TASK_KIND);
    return organizationId ? all.filter((t) => t.organizationId === organizationId) : all;
  }

  async saveSubmission(s: TaskSubmission): Promise<void> {
    await this.store.saveProjection(SUBMISSION_KIND, s.id, s);
  }

  async getSubmission(id: string): Promise<TaskSubmission | undefined> {
    return this.store.getProjection<TaskSubmission>(SUBMISSION_KIND, id);
  }

  async listSubmissions(taskId?: string): Promise<TaskSubmission[]> {
    const all = await this.store.listProjections<TaskSubmission>(SUBMISSION_KIND);
    return taskId ? all.filter((s) => s.taskId === taskId) : all;
  }
}

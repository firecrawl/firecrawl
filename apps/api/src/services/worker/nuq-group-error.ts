export class GroupNotActiveError extends Error {
  constructor(public readonly groupId: string) {
    super(`Queue group ${groupId} is no longer active`);
    this.name = "GroupNotActiveError";
  }
}

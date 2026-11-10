export class RoleNotGranted extends Error {
  constructor() {
    super("role-not-granted");
  }
}

export class RecordNotFound extends Error {
  constructor() {
    super("not-found");
  }
}

export class Conflict extends Error {
  constructor() {
    super("conflict");
  }
}

export class RelationshipConflict extends Error {
  constructor() {
    super("relationship");
  }
}

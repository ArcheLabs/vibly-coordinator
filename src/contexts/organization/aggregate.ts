/**
 * Organization aggregate — pure state-machine.
 *
 * No I/O here.  `apply` takes the current state (or undefined for creation)
 * plus a domain event and returns the next state.
 */

import type { Organization, OrganizationHandbook, OrganizationMember, AuthorityAssignment } from "./types.js";

export type OrganizationEvent =
  | { type: "OrganizationCreated"; payload: { id: string; name: string; description?: string; chainId?: string; createdBy: string; createdAt: string } }
  | { type: "HandbookUpdated"; payload: { organizationId: string; handbook: OrganizationHandbook; updatedAt: string } }
  | { type: "OrganizationUpdated"; payload: { organizationId: string; name?: string; description?: string; updatedBy: string; updatedAt: string } }
  | { type: "OrganizationDissolved"; payload: { organizationId: string; dissolvedBy: string; dissolvedAt: string } }
  | { type: "MemberAdded"; payload: { organizationId: string; member: OrganizationMember } }
  | { type: "MemberRemoved"; payload: { organizationId: string; principalId: string; removedAt: string } }
  | { type: "AuthorityGranted"; payload: { organizationId: string; assignment: AuthorityAssignment } }
  | { type: "AuthorityRevoked"; payload: { organizationId: string; principalId: string; authority: string; revokedAt: string } }
  | { type: "OrganizationPaused"; payload: { organizationId: string; pausedAt: string; reason?: string } }
  | { type: "OrganizationResumed"; payload: { organizationId: string; resumedAt: string } };

export function apply(
  state: Organization | undefined,
  event: OrganizationEvent,
): Organization {
  const now = new Date().toISOString();

  if (event.type === "OrganizationCreated") {
    if (state) throw new Error("Organization already exists");
    const { id, name, description, chainId, createdBy, createdAt } = event.payload;
    return {
      id,
      name,
      description,
      chainId,
      status: "active",
      members: [],
      authorities: [],
      createdBy,
      createdAt,
      updatedAt: createdAt,
    };
  }

  if (!state) throw new Error(`Organization not found; cannot apply ${event.type}`);

  switch (event.type) {
    case "HandbookUpdated":
      return { ...state, handbook: event.payload.handbook, updatedAt: event.payload.updatedAt };

    case "OrganizationUpdated": {
      const { name, description, updatedBy, updatedAt } = event.payload;
      return {
        ...state,
        name: name ?? state.name,
        description: description !== undefined ? description : state.description,
        updatedBy,
        updatedAt,
      };
    }

    case "OrganizationDissolved":
      return {
        ...state,
        status: "dissolved",
        dissolvedAt: event.payload.dissolvedAt,
        dissolvedBy: event.payload.dissolvedBy,
        updatedAt: event.payload.dissolvedAt,
      };
    case "MemberAdded":
      return {
        ...state,
        members: [
          ...state.members.filter((m) => m.principalId !== event.payload.member.principalId),
          event.payload.member,
        ],
        updatedAt: now,
      };

    case "MemberRemoved":
      return {
        ...state,
        members: state.members.filter((m) => m.principalId !== event.payload.principalId),
        updatedAt: event.payload.removedAt,
      };

    case "AuthorityGranted":
      return {
        ...state,
        authorities: [
          ...state.authorities.filter(
            (a) =>
              !(a.principalId === event.payload.assignment.principalId &&
                a.authority === event.payload.assignment.authority),
          ),
          event.payload.assignment,
        ],
        updatedAt: now,
      };

    case "AuthorityRevoked":
      return {
        ...state,
        authorities: state.authorities.filter(
          (a) =>
            !(a.principalId === event.payload.principalId && a.authority === event.payload.authority),
        ),
        updatedAt: event.payload.revokedAt,
      };

    case "OrganizationPaused":
      return { ...state, status: "paused", updatedAt: event.payload.pausedAt };

    case "OrganizationResumed":
      return { ...state, status: "active", updatedAt: event.payload.resumedAt };

    default: {
      const _exhaustive: never = event;
      return state;
    }
  }
}

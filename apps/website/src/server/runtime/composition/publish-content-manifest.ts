import { contributeFormPublish } from "#src/features/forms/publish-content";
import { contributeMediaPublish } from "#src/features/media/publish-content";
import { contributeMenusPublish } from "#src/features/navigation/publish-content";
import { contributePagePublish, contributePostPublish } from "#src/features/post/publish-content";
import { registerPublishContentContributor } from "#src/features/publish-content/type-registry";
import { contributeRedirectPublish } from "#src/features/redirects/publish-content";
import { contributeThemeFilesPublish } from "#src/features/theme/publish-content";

/**
 * @file Task 2 of the publish-content (Publish Content) feature — the composition-root wiring
 * point plan §3 rule 1 calls for: "`server/runtime/composition/tool-catalog-manifest.ts`'s
 * `installFirstPartyToolContributors` (or a **sibling** `installFirstPartyPublishContentTypes`)".
 *
 * A sibling, NEW file — deliberately not folded into `tool-catalog-manifest.ts` itself. That file
 * wires the AI-assistant's tool CATALOG (`ToolContributor`s); this registers content TYPES for the
 * Publish Content HTTP feature, a different registry with a different consumer (Task 4's export
 * route and Task 5's planner, not `buildAssistantToolRegistrations`). Keeping the two `install*`
 * functions in separate files means a future Task 3/4 PR that starts calling this one does not have
 * to touch — or risk a merge conflict in — `tool-catalog-manifest.ts`'s own ~35-domain call list.
 *
 * Called from TWO boot paths (2026-09-23): `modules/publish-content.ts` inside `createApp()`, and
 * `tool-catalog-manifest.ts`'s `installFirstPartyToolContributors()`, which is how the agent daemon
 * (a separate process that never runs `createApp()`) gets the types its publish tools read. The
 * history below explains the original, since-superseded "not yet called" state.
 *
 * Originally NOT YET CALLED from a real boot path. Nothing in the tree yet consumed
 * `listPublishContentContributors()` (Task 4's export route is the first real reader), so calling
 * this from `agent-daemon-server.ts`/`assistant-byok.ts` today would register two contributors that
 * are never read by anything and add a shared-file edit with no test coverage to justify it. Task 4's
 * own composition module (`server/runtime/composition/modules/publish-content.ts`, not yet built)
 * is the natural place to call `installFirstPartyPublishContentTypes()` once there is a real consumer —
 * see `ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §1.1/§4 task 4.
 *
 * `media` joined `post`/`page` here only once `features/media/publish-content.ts`'s `apply()` was a
 * real write path rather than Task 12's deliberate throwing stub. Registering a type whose `apply()`
 * throws would have turned a correct refusal into a live bug — a bundle carrying media would have
 * planned cleanly and then aborted the whole run mid-apply. The registration and the working
 * `apply()` therefore land in the same commit, never separately; `__tests__/publish-content-manifest
 * .test.ts` pins both halves (the registry list AND an entity actually applying through the
 * registered contributor), so the pair cannot silently come apart again. `theme-files` followed the
 * same rule (S-F4): registered only once its stage/verify/swap `apply()` was real AND the apply bag
 * (`apply-loop.ts`'s `PublishContentApplyDeps`) required `themesDir`.
 */
export function installFirstPartyPublishContentTypes(): void {
  registerPublishContentContributor(contributePostPublish());
  registerPublishContentContributor(contributePagePublish());
  registerPublishContentContributor(contributeMediaPublish());
  registerPublishContentContributor(contributeRedirectPublish());
  registerPublishContentContributor(contributeMenusPublish());
  registerPublishContentContributor(contributeThemeFilesPublish());
  registerPublishContentContributor(contributeFormPublish());
}

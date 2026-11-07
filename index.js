/**
 * Host half of the follow-until-screen bundle.
 *
 * The behavior lives entirely in the Web client: it watches the current
 * turn's response row and releases conversation tail-following when that row
 * fills one screen, and re-applies the same rule when a Session that was left
 * while tail-following is shown again. The Host entry exists so the bundle has
 * a loadable row.
 */
export function apply() {}

'use strict';
const { uid } = require('./util');
/** CEO → Director bridge. The CEO never edits the station; it queues directives the Director's autopilot drains into its normal assign_task flow. */
function makeDirectives(ctx) {
  const D = () => ctx.db.get('directives', []);
  function add(d) {
    if (!ctx.ventures.canWork(d.venture_id)) return null;                       // never queue work for dead ventures
    const dup = D().find((x) => x.venture_id === d.venture_id && x.task === d.task && x.status === 'open'); if (dup) return dup;
    const recent = D().find((x) => x.venture_id === d.venture_id && x.task === d.task && ['assigned', 'done'].includes(x.status) && ctx.now() - (x.assigned || x.created) < 24 * 3600000);
    if (recent) return recent;                                                    // cooldown: the same instruction is not re-issued every tick
    const x = { id: uid('dir'), status: 'open', priority: 'normal', created: ctx.now(), ...d }; D().push(x); ctx.db.save('directives'); return x;
  }
  const list = (f = {}) => D().filter((d) => (!f.venture_id || d.venture_id === f.venture_id) && (!f.status || d.status === f.status));
  const cancelFor = (venture_id) => { for (const d of D()) if (d.venture_id === venture_id && d.status === 'open') d.status = 'cancelled'; ctx.db.save('directives'); };
  /** assign(directive) → truthy if the Director accepted it (e.g. wraps the existing assign_task action). */
  async function drain(assign, { max = 10 } = {}) {
    let n = 0;
    for (const d of D().filter((x) => x.status === 'open').sort((a, b) => (b.priority === 'high') - (a.priority === 'high'))) {
      if (n >= max) break;
      if (!ctx.ventures.canWork(d.venture_id)) { d.status = 'cancelled'; continue; }
      if (await assign(d)) { d.status = 'assigned'; d.assigned = ctx.now(); n++; }
    }
    ctx.db.save('directives'); return n;
  }
  const complete = (id) => { const d = D().find((x) => x.id === id); if (d) { d.status = 'done'; ctx.db.save('directives'); } };
  return { add, list, cancelFor, drain, complete };
}
module.exports = { makeDirectives };

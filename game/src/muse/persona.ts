/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — muse/persona.ts — the offline Muse persona's voice
 * (Phase 2).
 *
 * Responsibilities:
 *  - `PersonaEvent`: everything the persona reacts to — game events,
 *    milestones, taunts, campaign scripted messages.
 *  - `personaLine(event, tick)`: deterministic event → line of dialogue.
 *    Line selection is an FNV-1a hash of (event kind + tick), so the same
 *    game stream always hears the same Muse. No RNG, no network, no
 *    wall clock.
 *  - The persona is the president's chief of staff: witty, supportive,
 *    lightly cheeky. Taunts are aimed at the *situation*, never toxic.
 *
 * Pure data + pure functions. No DOM, no sim mutation — safe under
 * Node/vitest. Rendering lives in ui/musebox.ts; event detection lives
 * in muse/controller.ts.
 */

export type PersonaEvent =
  | { kind: 'gameStart'; missionName?: string }
  | { kind: 'buildingComplete'; building: string }
  | { kind: 'unitTrained'; unit: string }
  | { kind: 'ageAdvanced'; age: string }
  | { kind: 'programChosen'; program: string }
  | { kind: 'unitLost'; unit: string }
  | { kind: 'warCoreFallen' }
  | { kind: 'wonderCountdown'; phase: 'start' | 'warn' | 'cancelled'; detail: string }
  | { kind: 'offensiveWarning'; phase: 'probe' | 'offensive' | 'allIn' }
  | { kind: 'offensiveLaunched'; phase: 'probe' | 'offensive' | 'allIn' }
  | { kind: 'rivalAgeUp'; age: string; program: string }
  | {
      kind: 'envoy';
      phase:
        | 'inbound'
        | 'waiting'
        | 'refusalWaiting'
        | 'accepted'
        | 'declined'
        | 'timedOut'
        | 'recalled';
    }
  | { kind: 'enemyDown' }
  | { kind: 'enemySpotted' }
  | { kind: 'combatStarted' }
  | { kind: 'lowFunds' }
  | { kind: 'objectiveComplete'; label: string }
  | { kind: 'victory' }
  | { kind: 'defeat' }
  | { kind: 'taunt'; context: 'losing' | 'winning' | 'stalemate' }
  | { kind: 'trick'; description: string }
  | { kind: 'advice'; text: string }
  | { kind: 'missionMessage'; text: string };

const LINES: Record<string, string[]> = {
  gameStart: [
    'President. The republic is yours — try not to break it before lunch.',
    'Day one. The desk is big, the chair is bigger, and the to-do list is biggest.',
    'All systems nominal, all advisors caffeinated. Your move, President.',
  ],
  buildingComplete: [
    'Construction complete. The ribbon-cutting industrial complex approves.',
    'Another building joins the republic. Somewhere, a bureaucrat weeps with joy.',
    'Built! I took the liberty of ordering the commemorative plaque.',
  ],
  unitTrained: [
    'New recruit reporting for duty. Polished boots, big dreams.',
    'Fresh unit off the line. I gave them the good helmets.',
    'Reinforcements! I told them you were worth following. Mostly true.',
  ],
  ageAdvanced: [
    'A new age dawns. I can feel the GDP rising already.',
    'Age advanced! The historians just got busier.',
    'Progress! Somewhere a rival president just spat out their coffee.',
  ],
  programChosen: [
    'National Program locked in. No take-backs — I checked twice.',
    'A bold choice, President. History will grade on a curve.',
    'Program adopted. The focus groups are thrilled. Probably.',
  ],
  unitLost: [
    'We lost a unit. I have notified their next of kin and the treasury.',
    'Casualty report on your desk. War is expensive; this one cost extra.',
    'One of ours is down. The memorial committee has been informed.',
  ],
  warCoreFallen: [
    'President — our war core has fallen. No army, no military production. Defeat is imminent.',
    'The last armory is gone and the field is empty. I am sorry, President — this is the end of the war.',
    'War core destroyed. We have nothing left to fight with. Brace for the surrender.',
  ],
  'wonderCountdown:start': [
    'A wonder rises — or a treasury swells. Five minutes, President. Make them count.',
    'The endgame just started. Somebody is about to win; I suggest it be us.',
    'Five minutes on the clock. History is watching, and so am I.',
  ],
  'wonderCountdown:warn': [
    'The clock is bleeding out, President. If that countdown hits zero, it is over.',
    'Time check: the end is scheduled. Shall we reschedule it with artillery?',
    'Minutes left on the wonder clock. I have moved the good china twice already.',
  ],
  'wonderCountdown:cancelled': [
    'The countdown is broken! Somebody just kicked over the hourglass.',
    'No more countdown — the leader lost their grip. Back to the grind, President.',
    'The wonder clock stopped. Breathe. Then get back to work.',
  ],
  'offensiveWarning:probe': [
    'Scouts report the rival is probing our border, President. A small force — they are testing our fences.',
    'Movement on the border: a rival probe. Swat it, and they will think twice about the next one.',
    'The rival is sniffing around our perimeter. Small force, but probes have a way of becoming offensives.',
  ],
  // Fun-audit Tier 4 (E1, 2026-10-02): the envoy ceremony — dry
  // presidential humor. The envoy is neutral and unarmed; the joke
  // is the protocol, never the violence.
  'envoy:inbound': [
    'A black SUV just crossed the border, President. Neutral plates. I checked twice.',
    'Diplomatic traffic on the road, President — one unarmed SUV, straight for our gates. I have put the good china out.',
    'The Directorate sent a car, not a column. Somebody wants to talk.',
  ],
  'envoy:waiting': [
    'The envoy is at the gates with a ceasefire offer. Sixty seconds to decide — silence counts as yes, so decide loudly.',
    'A ceasefire is on the table, President, and the envoy is watching the clock. So am I.',
    'The envoy waits. Five minutes of quiet if you say yes; sixty seconds to say it in.',
  ],
  'envoy:refusalWaiting': [
    'The envoy brings a refusal, President. They insisted on delivering it in person. Some people enjoy their work.',
    'The rival said no — via a chauffeured SUV. I admire the commitment to ceremony.',
    'A refusal, hand-delivered. Dismiss them when ready, President.',
  ],
  'envoy:accepted': [
    'Ceasefire signed. Five minutes of quiet — the doves are away, and so is my blood pressure.',
    'Done, President. Five minutes of peace, sealed with doves. I have scheduled the worrying for later.',
    'The guns go quiet for five minutes. Enjoy it — I will be here, counting.',
  ],
  'envoy:declined': [
    'Declined. The envoy is driving home. I waved.',
    'No deal, President. The SUV is turning around — the war continues.',
    'You said no, and the envoy took it gracefully. Back to business.',
  ],
  'envoy:timedOut': [
    'The envoy took your silence for consent. Bold strategy, President — it worked.',
    'Sixty seconds passed, so the envoy signed for you. The ceasefire stands.',
    'You said nothing, and the envoy heard yes. Diplomacy!',
  ],
  'envoy:recalled': [
    'The war ended mid-ceremony. The envoy turned around — even diplomats hate a wasted trip.',
    'No war, no envoy. They are driving home, President.',
    'The ceremony is cancelled — the war it was about just ended.',
  ],
  'offensiveWarning:offensive': [
    'The rival is massing for a genuine offensive. I suggest we greet them with more than harsh language.',
    'Scouts confirm it: a real attack is forming up. Reinforce the line, President.',
    'Enemy columns are gathering. This is not a probe — brace for an offensive.',
  ],
  'offensiveWarning:allIn': [
    'This is it, President — the rival is coming with everything they have. All hands to battle stations.',
    'Total commitment inbound. They are betting the war on one push — let us make it a bad bet.',
    'Every scout report says the same thing: all-in. Dig in and make them pay for every meter.',
  ],
  'offensiveLaunched:probe': [
    'Rival probe inbound. Swat it and send them the bill.',
    'The probe is moving. A sharp rebuke should discourage the next one.',
  ],
  'offensiveLaunched:offensive': [
    'The rival offensive has begun. Hold the line, President.',
    'Contact! Their offensive is underway — generals to their posts.',
  ],
  'offensiveLaunched:allIn': [
    'They are all in. So are we. For the republic!',
    'The all-out assault has begun. Everything we have built comes down to this.',
  ],
  rivalAgeUp: [
    'The rival just aged up, President — and spent a fortune doing it. Their labs are humming; their barracks are not. Opportunity knocks.',
    'Intelligence confirms: the rival has advanced, and it cost them dearly. Tech instead of tanks — shall we send a welcoming committee?',
    'The rival bought progress instead of an army. Bold. Expensive. Let us make them regret the timing.',
  ],
  enemyDown: [
    'Enemy unit destroyed. Their insurance premiums just went up.',
    'That one will not be bothering us again. Efficient!',
    'Direct hit. I am updating the victory slide deck as we speak.',
  ],
  enemySpotted: [
    'Scouts report movement. Unfriendly movement, if the flags are any indication.',
    'Contact! Somebody out there did not get the memo about peace.',
    'Bogeys on the horizon. Shall I alert the generals, or do you want to wave first?',
  ],
  combatStarted: [
    'Weapons free! Try to look presidential while it happens.',
    'It is official: we are in a fight. I have moved the good china.',
    'Combat! Remember: the camera adds ten pounds, but subtracts zero excuses.',
  ],
  lowFunds: [
    'Treasury alert: the coffers are echoing. Taxes, trade, or… the console. I saw nothing.',
    'We are nearly broke, President. Shall I sell the presidential yacht? We do not have one. Yet.',
    'Funds critical. The accountants are stress-eating the spreadsheets.',
  ],
  objectiveComplete: [
    'Objective complete. I am framing this one.',
    'Done and done. The history books just got a new paragraph.',
    'Objective secured. I told the press it was all your idea.',
  ],
  victory: [
    'Victory! Confetti cannons: fired. Approval rating: stratospheric.',
    'We won! I have already commissioned the commemorative stamps.',
    'Triumph! The other presidents are pretending they are not jealous.',
  ],
  defeat: [
    'Defeat. I have prepared three concession speeches: gracious, defiant, and interpretive dance.',
    'We lost this one. The good news: terms end, and legends get sequels.',
    'A setback, not an ending. I have already drafted the comeback tour.',
  ],
  'taunt:losing': [
    'The rival sends their regards — and, quote, "thoughts and prayers". Rude.',
    'Their commander just named a bridge after this victory. We will rename it later.',
    'They are celebrating over there. Let them. Celebrations make people careless.',
  ],
  'taunt:winning': [
    'Their commander requests a rematch. I told them the calendar is full until never.',
    'The rival\u2019s war room has gone very quiet. I can hear it from here.',
    'They just promoted the general who lost to us. Bold strategy.',
  ],
  'taunt:stalemate': [
    'Both sides are staring at each other. I brought popcorn.',
    'A staring contest, then. We have the better stare. Probably.',
    'Neither side will commit. Classic. I have seen bolder moves at budget hearings.',
  ],
  trick: [
    'Heads up — {description} Classic misdirection. Rude, but legal.',
    'They are up to something: {description} Keep an eye on the flanks.',
    'Sneaky! {description} I respect the audacity, not the target.',
  ],
};

function eventKey(event: PersonaEvent): string {
  switch (event.kind) {
    case 'taunt':
      return `taunt:${event.context}`;
    case 'wonderCountdown':
      return `wonderCountdown:${event.phase}`;
    case 'offensiveWarning':
      return `offensiveWarning:${event.phase}`;
    case 'offensiveLaunched':
      return `offensiveLaunched:${event.phase}`;
    case 'envoy':
      return `envoy:${event.phase}`;
    default:
      return event.kind;
  }
}

/** FNV-1a hash — same family as the sim digest. */
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic line for an event at a tick. `missionMessage` and
 * `advice` pass their text through (they carry author-written content).
 */
export function personaLine(event: PersonaEvent, tick: number): string {
  if (event.kind === 'missionMessage') return event.text;
  if (event.kind === 'advice') return `Live Muse suggests: ${event.text}`;
  const key = eventKey(event);
  // B27: no `!` — the stalemate fallback is always populated; the modulo
  // index is always in bounds.
  const lines = LINES[key] ?? LINES['taunt:stalemate'] ?? [];
  let line = lines[hash32(`${key}:${tick}`) % lines.length] ?? '';
  if (event.kind === 'trick') line = line.replace('{description}', event.description);
  if (event.kind === 'objectiveComplete') line = `${line} (${event.label})`;
  if (event.kind === 'gameStart' && event.missionName) {
    line = `${line} Mission: ${event.missionName}.`;
  }
  if (event.kind === 'buildingComplete') line = `${line.replace(/\.*$/, '')} — ${event.building}.`;
  if (event.kind === 'unitTrained') line = `${line.replace(/\.*$/, '')} — ${event.unit}.`;
  if (event.kind === 'ageAdvanced') line = `${line} Welcome to the ${event.age} age.`;
  if (event.kind === 'programChosen') line = `${line} (${event.program})`;
  if (event.kind === 'unitLost') line = `${line.replace(/\.*$/, '')} (${event.unit} lost).`;
  if (event.kind === 'wonderCountdown') line = `${line} (${event.detail})`;
  if (event.kind === 'rivalAgeUp') {
    const prog = event.program ? ` — ${event.program}` : '';
    line = `${line} (${event.age}${prog})`;
  }
  return line;
}

/** All event keys with authored lines (for tests). */
export function personaEventKeys(): string[] {
  return Object.keys(LINES);
}

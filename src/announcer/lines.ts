/**
 * What the ring announcer says. EPIC: a booming arena announcer, every line ending in an exclamation mark, as if each bump
 * were the biggest moment in history. Still kind and short, for children aged 4 to 6: slapstick only, never mean about a
 * creature, nothing scary, no injuries. A ring-out goes into the ball pit and is a legendary splash.
 * Slots: `{name}` (the one doing it), `{other}` (the one it happens to), `{names}` (everyone in a group), `{special}` (a
 * special attack's name, e.g. "MEGA PUNCH"), `{event}` (a ring event's name, e.g. "BOUNCE PARTY"). Names, specials and
 * events are shouted.
 * An intro is not here: it is the recipe's own `fight.intro` (see `introText` in announcer.ts).
 */

export type Beat =
  | 'intro' | 'groupIntro' | 'hit' | 'bigHit' | 'special' | 'ringOut' | 'holdsRing' | 'lone' | 'tie' | 'crown' | 'again' | 'ringEvent' | 'throw';

/** The words a line may use. Missing ones get a friendly stand-in, so no slot is ever left showing. */
export type Slots = Partial<Record<'name' | 'other' | 'names' | 'special' | 'maker' | 'weight' | 'event', string>>;

/** The longest line, in characters, with every slot filled by a short name. */
export const LINE_MAX = 120;

const SHOUTED = new Set(['name', 'other', 'names', 'special', 'event']);
const STAND_IN: Record<string, string> = {
  name: 'OUR HERO', other: 'THEIR PAL', names: 'EVERYBODY', special: 'SUPER MOVE', maker: 'a mystery maker', weight: 'a mystery weight',
  event: 'PARTY TIME',
};

/** Fills every `{slot}` in one pass (so a name holding braces cannot make a new slot); names go in capitals, shouted. */
export function fillSlots(text: string, slots: Slots): string {
  return text.replace(/\{(name|other|names|special|maker|weight|event)\}/g, (_, k: keyof Slots) => {
    const v = slots[k]?.replace(/[{}]/g, '').trim();
    if (!v) return STAND_IN[k];
    return SHOUTED.has(k) ? v.toUpperCase() : v;
  });
}

export const LINES: Record<Exclude<Beat, 'intro'>, readonly string[]> = {
  groupIntro: [
    'Ladies and gentlemen, boys and girls! Please welcome {names}!',
    'Here they come, ready to rumble together! {names}!',
    'Make some NOISE for the mighty {names}!',
    'The moment you have all been waiting for! {names}!',
    "It's the big, bold, brilliant {names}!",
    'Stomp your feet, everybody! Here come {names}!',
    'Into the ring of legends come {names}!',
    'The crowd is on its feet for {names}!',
  ],
  hit: [
    'BOOM! {name} bounces {other} off the springy floor!',
    'WHAM! What a mighty bonk from {name}!',
    'Unbelievable! {other} wobbles like a giant jelly!',
    'Look at {name} go! Unstoppable!',
    'Spectacular! {other} spins like a tornado!',
    'A thunderous slap from {name}!',
    'BOOP! The legendary nose boop from {name}!',
    'WHOOSH! {other} does a whirlwind twirl!',
    'What a springy smash-up, folks!',
    '{name} is bouncing all over the ring!',
    'Bounce! Bounce! BOUNCE! The crowd is roaring!',
    'Squish! Squash! {other} goes wobbling by!',
    'A super spin from the mighty {name}!',
    '{other} takes a tremendous tickle-bump from {name}!',
    'Flip! Flop! FLAP! What a fight!',
    'Fantastic footwork from {name}!',
    'Hold on, {other}! What a wobble!',
    'POW! Right in the pillow zone!',
    '{name} bumps {other} and the crowd goes wild!',
    'Boing! Boing! BOING! Like a super ball!',
    'A colossal bump for {other}!',
    'Here comes {name}, charging across the ring!',
    '{other} bounces right back! What a hero!',
    'A wonderful, wiggly WALLOP from {name}!',
    'SWOOSH! {name} is on the move!',
    'The crowd LOVES a big bump!',
    'BLIP! BLOP! BUMP! The greatest fight ever!',
    '{other} goes tumbling across the ring!',
    'Sky high! {name} is bouncing to the moon!',
    'THWACK! Did you hear that, {name}!',
  ],
  bigHit: [
    'KA-BOOM! {name} launches {other} like a cannonball!',
    'WHOA! {other} is soaring through the sky!',
    'The launch of the CENTURY from {name}!',
    'BOING! {other} bounces up to the clouds!',
    'A GIANT wallop from {name}! The crowd goes wild!',
    'ZOOOOM! {other} is a rocket ship!',
    'Holy hopping hippos! What a bounce!',
    'Look at {other} go! Up, up and AWAY!',
    'The biggest boing in history, from {name}!',
    'SUPER DUPER bump from the mighty {name}!',
    'WHEEEE! {other} is flying through the air!',
    'MEGA BONK! {name} is unstoppable!',
    '{other} bounces and bounces and BOUNCES!',
    'WOW! {name} gives {other} a gigantic shove!',
    'All the way across the ring! {other} is flying!',
    'What a WHOPPER of a whack from {name}!',
    "KA-POW! The crowd can't believe their eyes!",
    '{name} with the BIGGEST boing of all time!',
    'Hold on to your hats! {other} is flying by!',
    'Super-sized power from {name}!',
    '{other} goes rolling and tumbling around the ring!',
    'What a tumble! The whole arena is shaking!',
    'BAM! Did you SEE that one, everybody?!',
    'Look out below! {other} is coming in for a landing!',
    'A FANTASTIC fling from {name}!',
    '{other} spins around and around and AROUND!',
    'A WHOPPING great wallop, folks!',
    'YIPPEE! {name} has the power of a thousand pogo sticks!',
    'Up, up, UP goes {other}! See you later!',
    'That is what we call a LEGENDARY bump!',
  ],
  special: [
    'Here it comes! {name} is charging up the {special}!',
    '{name} is GLOWING! Get ready for the {special}!',
    "Hold on to your hats, everybody! It's the {special}!",
    "Look at {name} sparkle! That's the {special}!",
    'Here comes the {special}! {name} has been saving it up!',
    'Wiggle, wobble, WOW! {name} is winding up the {special}!',
    'This is it! {name} unleashes the {special}!',
    'Stand back, everybody! The {special} is coming!',
    '{name} is fully charged! Say it with me: {special}!',
    'Oh boy, oh boy! {name} has a super move: the {special}!',
    'Count with me! One! Two! {special}!',
    'The crowd is on its feet! {name} goes for the {special}!',
    "What's that glow?! It's the mighty {special} from {name}!",
    '{name} is buzzing with power! Here comes the {special}!',
    "Get ready to cheer! It's the {special} from {name}!",
    'A HUGE wind-up from {name}! The legendary {special}!',
    'ZING! ZANG! ZOOM! {name} lets loose the {special}!',
    'Power alert! {name} is powering up the {special}!',
  ],
  ringOut: [
    'SPLASH! {other} goes into the ball pit! HOORAY!',
    'KER-PLOP! {other} lands in the ball pit!',
    'Out of the ring and into the ball pit! What a splash!',
    'SPLISHY SPLASHY! {other} dives into the ball pit!',
    'Into the ball pit goes {other}! Bounce, bounce!',
    'Ball pit party for {other}! Everybody cheer!',
    'Over the edge! {other} giggles in the pile of balls!',
    'The most EPIC splash of the day for {other}!',
    '{other} with a perfect ten dive into the ball pit!',
  ],
  holdsRing: [
    '{name} is STILL in the ring! What a champion bounce!',
    'Still standing: the bold, brilliant {name}!',
    '{name} holds the ring! Mighty wobbling!',
    'Hooray for {name}! Still going strong!',
    'What a wiggler! {name} stays in the ring!',
    "{name} isn't going anywhere! Not today!",
    'Rock steady! {name} is still here!',
    'The crowd chants for {name}!',
  ],
  lone: [
    '{name} is all alone in the ring! Give a wave!',
    'Only {name} left! What a day!',
    "It's just {name} now! Hip hip HOORAY!",
    '{name} is the last one standing!',
    'Just one hero left: {name}!',
    'All alone in the ring, {name} does a victory dance!',
    'The ring is quiet, except for the mighty {name}!',
    '{name} has the whole ring to bounce in!',
  ],
  tie: [
    "It's a tie! Everyone splashes together!",
    'A TIE! One giant splash for everybody!',
    'Nobody wins, everybody wiggles! A tie!',
    "Into the ball pit together! It's a draw!",
    'What a finish! A tie, folks!',
    "It's a draw! High fives all around!",
    'A tie! The crowd cheers for everyone!',
    'Nobody left in the ring! Everyone is a winner!',
  ],
  crown: [
    'And the CHAMPION of the ring is... {name}! HOORAY!',
    'All hail {name}, the champion of the world!',
    'A thunderous round of applause for {name}! You did it!',
    '{name} wins the Rumble! What a legend!',
    'Our champion: the one, the only, {name}!',
    'Put the crown on {name}! The greatest of all time!',
    'Hip hip HOORAY for {name}! CHAMPION!',
    '{name} is the mightiest bouncer in the whole ring!',
    "Confetti for {name}! You're the champion!",
  ],
  ringEvent: [
    "It's {event} time, everybody!",
    'DING DING DING! Here comes {event}!',
    'Hold on to your socks! It is {event}!',
    'The ring is going WILD! {event}!',
    'What is THIS?! It is {event}!',
    'Surprise, everybody! {event}!',
    'Let the fun begin! {event}!',
    "Everybody get ready! It's {event}!",
    'The crowd goes bananas for {event}!',
    'WHOOPEE! The ring says {event}!',
    'Three! Two! One! {event}!',
    "Look out, it's {event}!",
  ],
  throw: [
    'YOINK! {name} picks up {other}!',
    'Up, up and away! {name} lifts {other} sky high!',
    '{name} scoops up {other} like a giant teddy bear!',
    'WHOA! {other} is up over the head of {name}!',
    '{name} has {other}! Where is {other} going?!',
    'HEAVE HO! {name} gives {other} the ride of a lifetime!',
    'First-class airplane ride for {other}, from {name}!',
    'What a lift! {name} is SO strong!',
    '{other} goes up, up, UP! What a toss from {name}!',
    'WHEEE! {name} tosses {other} like a beach ball!',
    'Look at {other} fly! The toss of the century from {name}!',
    'A MIGHTY lift from {name}! Hold on, {other}!',
    '{name} says up you go, {other}!',
    'A twirl in the sky for {other}! Thanks, {name}!',
  ],
  again: [
    "Ready for another rumble? Let's go again!",
    'Who wants MORE? Round two!',
    'Back in the ring, everybody! Again! Again!',
    'That was LEGENDARY! Shall we go again?!',
    'Time for another mighty round!',
    'One more time! The crowd wants MORE!',
    'Everybody into the ring! Here we go again!',
    'The ring is ready for another round of glory!',
  ],
};

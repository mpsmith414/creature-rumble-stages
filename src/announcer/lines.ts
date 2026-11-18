/**
 * What the announcer says. EPIC: a booming announcer, every line ending in an exclamation mark, as if each bop were the
 * biggest moment in history. Still kind and short, for children aged 4 to 6: slapstick only, never mean about a
 * creature, nothing scary, no injuries. The fight is on a stage of floors and platforms: a knockout sends a creature
 * flying off the level (to twinkle away, splash in the river or float off into space) and back to the roster to rest.
 * Slots: `{name}` (the one doing it), `{other}` (the one it happens to), `{names}` (everyone in a group), `{special}` (a
 * special attack's name, e.g. "MEGA PUNCH"), `{event}` (a level mischief's name, e.g. "SWINGING VINES", or what is in a
 * present, e.g. "CUSTARD PIE"). Names, specials and events are shouted.
 * An intro is not here: it is the recipe's own `fight.intro` (see `introText` in announcer.ts).
 */

export type Beat =
  | 'intro' | 'groupIntro' | 'hit' | 'bigHit' | 'special' | 'knockOut' | 'holdsStage' | 'lone' | 'tie' | 'crown' | 'again'
  | 'levelEvent' | 'throw' | 'present' | 'aboutToFly';

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

/** Names said together: "A", "A and B", "A, B and C". */
export function namesOf(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export const LINES: Record<Exclude<Beat, 'intro'>, readonly string[]> = {
  groupIntro: [
    'Ladies and gentlemen, boys and girls! Please welcome {names}!',
    'Here they come, ready to rumble together! {names}!',
    'Make some NOISE for the mighty {names}!',
    'The moment you have all been waiting for! {names}!',
    "It's the big, bold, brilliant {names}!",
    'Stomp your feet, everybody! Here come {names}!',
    'Dropping in from the sky, the legendary {names}!',
    'The crowd is on its feet for {names}!',
  ],
  hit: [
    'BOOM! {name} gives {other} a mighty bop!',
    'WHAM! What a mighty bonk from {name}!',
    'Unbelievable! {other} wobbles like a giant jelly!',
    'Look at {name} go! Unstoppable!',
    'Spectacular! {other} spins like a tornado!',
    'A thunderous slap from {name}!',
    'BOOP! The legendary nose boop from {name}!',
    'WHOOSH! {other} does a whirlwind twirl!',
    'What a smash-up on the top floor, folks!',
    '{name} is hopping from platform to platform!',
    'Bop! Bop! BOP! The crowd is roaring!',
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
    'Here comes {name}, charging across the stage!',
    '{other} bounces right back! What a hero!',
    'A wonderful, wiggly WALLOP from {name}!',
    'SWOOSH! {name} is on the move!',
    'The crowd LOVES a big bump!',
    'BLIP! BLOP! BUMP! The greatest fight ever!',
    '{other} goes tumbling across the platform!',
    'Sky high! {name} leaps right over the top!',
    'THWACK! Did you hear that, {name}!',
  ],
  bigHit: [
    'KA-BOOM! {name} launches {other} like a cannonball!',
    'WHOA! {other} is soaring through the sky!',
    'The launch of the CENTURY from {name}!',
    'BOING! {other} bounces up to the clouds!',
    'A GIANT wallop from {name}! The crowd goes wild!',
    'ZOOOOM! {other} is a rocket ship!',
    'Holy hopping hippos! What a launch!',
    'Look at {other} go! Up, up and AWAY!',
    'The biggest boing in history, from {name}!',
    'SUPER DUPER bump from the mighty {name}!',
    'WHEEE! {other} is flying through the air!',
    'MEGA BONK! {name} is unstoppable!',
    '{other} spins and spins and SPINS!',
    'WOW! {name} gives {other} a gigantic shove!',
    'All the way across the level! {other} is flying!',
    'What a WHOPPER of a whack from {name}!',
    "KA-POW! The crowd can't believe their eyes!",
    '{name} with the BIGGEST boing of all time!',
    'Hold on to your hats! {other} is flying by!',
    'Super-sized power from {name}!',
    '{other} goes cartwheeling over the platforms!',
    'What a tumble! The whole place is shaking!',
    'BAM! Did you SEE that one, everybody?!',
    'Look out below! {other} is coming in for a landing!',
    'A FANTASTIC fling from {name}!',
    '{other} spins around and around and AROUND!',
    'A WHOPPING great wallop, folks!',
    'YIPPEE! {name} has the power of a thousand pogo sticks!',
    'Up, up, UP goes {other}! Hold on tight!',
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
  knockOut: [
    'BYE BYE, {other}! Off the level and into the history books!',
    'KER-ZOOM! {other} flies right off the stage! What a launch!',
    'Twinkle twinkle, {other}! A shooting star, folks!',
    'Off the edge goes {other}! Time for a well-earned rest!',
    'WHEEE! {other} sails off into the sunset!',
    'The most EPIC flight of the day for {other}!',
    '{other} with a perfect ten flight off the level!',
    'See you soon, {other}! What a superstar launch!',
    'OUT goes {other}! Give a big wave, everybody!',
  ],
  holdsStage: [
    '{name} is STILL on the stage! What a champion!',
    'Still standing: the bold, brilliant {name}!',
    '{name} holds the stage! Mighty wobbling!',
    'Hooray for {name}! Still going strong!',
    'What a wiggler! {name} stays on the level!',
    "{name} isn't going anywhere! Not today!",
    'Rock steady! {name} is still here!',
    'The crowd chants for {name}!',
  ],
  lone: [
    '{name} is all alone on the stage! Give a wave!',
    'Only {name} left! What a day!',
    "It's just {name} now! Hip hip HOORAY!",
    '{name} is the last one standing!',
    'Just one hero left: {name}!',
    'All alone up there, {name} does a victory dance!',
    'The whole level is quiet, except for the mighty {name}!',
    '{name} has every platform to strut on!',
  ],
  tie: [
    "It's a tie! Everyone flies off together!",
    'A TIE! One giant launch for everybody!',
    'Nobody wins, everybody wiggles! A tie!',
    "Off the level together! It's a draw!",
    'What a finish! A tie, folks!',
    "It's a draw! High fives all around!",
    'A tie! The crowd cheers for everyone!',
    'Nobody left on the stage! Everyone is a winner!',
  ],
  crown: [
    'And the CHAMPION of the stage is... {name}! HOORAY!',
    'All hail {name}, the champion of the world!',
    'A thunderous round of applause for {name}! You did it!',
    '{name} wins the Rumble! What a legend!',
    'Our champion: the one, the only, {name}!',
    'Put the crown on {name}! The greatest of all time!',
    'Hip hip HOORAY for {name}! CHAMPION!',
    '{name} is the mightiest creature on the whole level!',
    "Confetti for {name}! You're the champion!",
  ],
  levelEvent: [
    "It's {event} time, everybody!",
    'DING DING DING! Here comes {event}!',
    'Hold on to your socks! It is {event}!',
    'The level is going WILD! {event}!',
    'What is THIS?! It is {event}!',
    'Surprise, everybody! {event}!',
    'Let the fun begin! {event}!',
    "Everybody get ready! It's {event}!",
    'The crowd goes bananas for {event}!',
    'WHOOPEE! The level says {event}!',
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
    'Onto the next level, everybody! Again! Again!',
    'That was LEGENDARY! Shall we go again?!',
    'Time for another mighty round!',
    'One more time! The crowd wants MORE!',
    'Everybody drop in! Here we go again!',
    'A brand new level is ready for another round of glory!',
  ],
  present: [
    'A PRESENT FROM THE SKY! Who will grab the {event}?!',
    'Special delivery! The {event} is floating down!',
    'Look up, everybody! A present is coming!',
    'Ooh, a parachute! Is that the {event} in the box?!',
    'A gift from the clouds! Race for the {event}!',
    'What could be in the present? The {event}!',
    'Presents for everybody! Well, for ONE lucky creature!',
    'Down comes the present! First one there gets the {event}!',
    'A surprise box from the sky! Ready, set, RACE!',
    'Ding dong! Present delivery! The {event} is here!',
  ],
  aboutToFly: [
    'Uh-oh! See that red glow? Watch out, {name}! One more bop and off we go!',
    'Puff, puff, PUFF! Steam alert for {name}! Careful now!',
    'Look at those spinning eyes! Ready for take-off, {name}!',
    'Red alert for {name}! Next stop: the sky!',
    'Sweaty, steamy, spinny eyes! Hold on tight, {name}!',
    'Whoa! One big bump for {name} and WHEEE!',
    'The crowd holds its breath for {name}!',
    'Dizzy, dizzy eyes! Hang on in there, {name}!',
    'Glowing like a sunset! Stay on the stage, {name}!',
  ],
};

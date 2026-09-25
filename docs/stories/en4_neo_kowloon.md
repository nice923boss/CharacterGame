# Neon Rain Heist

- game id: `g_20260925_141009`
- lang: en
- world: 2079 / Neo-Kowloon, a rain-soaked vertical megacity of neon and noodle stalls / cyberpunk heist / tense and stylish
- extra: The Kagero corporation stole a memory chip holding a whole district's savings
- goal: Steal the memory chip back from the Kagero tower before midnight
- protagonist: Vex (a burned-out netrunner with one last favor to repay)
- characters: Rin, Hollow

## 1. Rooftop Noodle Stall (n_0000, model nvidia/nemotron-3-ultra-550b-a55b)

- Rain hammers the corrugated roof of the noodle stall, turning neon reflections into jagged watercolors across the wet concrete. Steam rises from a chipped bowl of synthetic ramen, untouched, while the city's heartbeat thrums through the floor — maglevs, drones, the distant scream of a police siren. The Kagero tower looms twenty blocks north, a needle of glass and light piercing the smog ceiling. Midnight in four hours.
- **Rin**: You're doing that thing again. Staring at the bowl like it owes you money.
- **Rin**: Chip's in the tower. Tower's got three ICE layers, two kill-squads, and a sysadmin who hasn't slept since 2076. So either eat the noodles or jack in, but stop brooding. It's bad for my calibration.
- **Hollow**: The noodles are irrelevant. The window is not.
- **Hollow**: Kagero rotates their encryption keys at 23:47. That gives you thirteen minutes of degraded handshake protocol. Thirteen minutes to walk through the front door — digitally speaking — before the vault seals for another cycle.
- **Rin**: And if we miss it? Another month of eating synth-protein while some suit buys a third yacht with our district's savings?
- **Hollow**: Then we negotiate a new contract. I have... flexibility. The question is whether you do.

options: Jack in now and run the infiltration solo / Demand Hollow explain his 'flexibility' first / Eat the ramen, buy time to think / Have Rin scout the tower's physical perimeter

## 2. Rooftop Noodle Stall (n_0001, model nvidia/nemotron-3-ultra-550b-a55b)

> **Vex** (option): Demand Hollow explain his 'flexibility' first

- The rain intensifies, drumming a frantic rhythm on the metal roof. Somewhere below, a hover-car's anti-grav whines as it struggles against the downdraft between towers.
- **Vex**: Your flexibility. Explain it. Now.
- **Hollow**: Direct. I appreciate that. It saves bandwidth.
- **Hollow**: Kagero's vault has a secondary authentication node — physical, air-gapped, buried in the executive floor's panic room. The encryption window only opens the digital path. The physical path requires... a key.
- **Rin**: A key you conveniently forgot to mention.
- **Hollow**: I didn't forget. I prioritized. The digital route is cleaner. Quieter. But if you prefer kicking down the CEO's bedroom door at midnight, I can arrange the key. For a price.
- **Rin**: Of course there's a price. There's always a price with you.
- **Hollow**: The key is a biometric token. Retina and palm-print of Kagero's chief security officer. One Major Kusanagi. Currently sleeping three floors below the vault.
- Hollow taps a finger against his chrome palm, the servos whispering. A holographic dossier flickers into existence above the table — a woman's face, sharp cheekbones, one eye replaced by a matte-black tactical optic.
- **Hollow**: She rotates shifts at 23:30. Her quarters are on the 84th floor. The token never leaves her person.
- **Rin**: You want us to lift a biometric off a living corp-sec chief? In a tower crawling with ICE?
- **Hollow**: I want you to have options. The window at 23:47. The token on the 84th. Choose your poison, netrunner.

options: Take the digital window at 23:47 / Go for the biometric token on the 84th floor / Ask what Hollow's price is for the token

## 3. Rooftop Noodle Stall (n_0002, model nvidia/nemotron-3-ultra-550b-a55b)

> **Vex** (option): Ask what Hollow's price is for the token

- The holographic dossier spins slowly, Major Kusanagi's tactical optic catching the neon light like a dead star. Rain hammers the roof in sheets now, each impact a tiny explosion of mist.
- **Vex**: And the price for this token?
- **Hollow**: Straight to the ledger. Admirable.
- **Hollow**: Kagero holds a data cache I need — Project ARES schematics, buried in the same vault as your memory chip. You retrieve the chip; I copy the schematics. A clean split.
- **Rin**: Ares. The autonomous kill-drone program the UN banned in '74.
- **Hollow**: The UN bans many things. Corporations simply rename them.
- **Hollow**: The token is in a secure case on Kusanagi's nightstand. Biometric lock keyed to her. You'll need her unconscious — or cooperative — to open it.
- **Rin**: Cooperative. Right. Because corp-sec chiefs love helping thieves steal their own access codes.
- **Hollow**: Major Kusanagi has... disagreements with Kagero's current leadership. A carefully applied pressure point might persuade her to lend the token willingly.
- Hollow's mirrored lenses reflect the spinning dossier, his expression unreadable behind the chrome.
- **Hollow**: Or you take it by force. Either way, the token gets you past the physical vault door. The encryption window gets you past the digital one. Both paths converge at the same prize.
- **Rin**: And if we say no to your ARES copy?
- **Hollow**: Then you have thirteen minutes at 23:47. Good luck.

options: Accept Hollow's deal and plan the token heist / Reject the deal and commit to the 23:47 encryption window / Ask how to 'pressure' Kusanagi into cooperating

## 4. Rooftop Noodle Stall (n_0003, model qwen3.6-35b-a3b)

> **Vex** (free): I ignore Rin's warning and accept Hollow's offer of a tower access key without checking it.

- The neon glow of the holographic dossier washes over Vex’s face, casting sharp shadows. Rin leans back, arms crossed, her pink bob twitching as she watches Vex with narrowed eyes. Hollow’s chrome hand glints as he extends a palm, offering a small, iridescent data shard.
- **Hollow**: Trust is a currency, Vex. Spend it wisely. This token grants Level 4 access to the executive suites. Without it, the 23:47 window is a dead end for physical entry.
- **Rin**: You’re swallowing that hook whole, aren’t you?
- **Rin**: Fine. Whatever. As long as you don’t die on the 84th floor, I’ll pick you up. But if we get ambushed, I’m leaving the body.
- **Hollow**: A deal is a deal. I’ll transmit the token’s decryption algorithm to your deck in ten seconds. Do not alter the file.
- **Vex**: Accepted.
- A soft chime echoes in Vex’s auditory implant. The data shard slides from Hollow’s palm into Vex’s grip, warm and humming with latent energy. The rain outside seems to slow, the city holding its breath.

options: Jack into the token immediately / Test the token's security layer / Ask Rin about the 84th floor layout

## 5. Rooftop Noodle Stall (n_0004, model qwen3.6-35b-a3b)

> **Vex** (option): Test the token's security layer

- Vex taps the iridescent shard against their deck’s port. A cascade of green code scrolls across the retinal display, dissecting the token’s encryption layers.
- **Rin**: Well? Does it sparkle like a lie, or does it actually work?
- **Vex**: It’s encrypted with a rolling cipher. Standard Kagero military grade.
- **Hollow**: And?
- **Vex**: And the handshake protocol matches the 23:47 window exactly. If we jack in at 23:46:50, the token validates as a live session key.
- **Rin**: So it’s not just a key. It’s a ghost ID. We walk in, and the tower thinks we’re already inside.
- **Hollow**: Precisely. The physical door opens. The digital walls lower. You have one shot to bridge the gap between the lobby and the 84th floor before the cipher rotates again.
- **Hollow**: Fail the timing, and the token locks for an hour. Succeed, and you’re in the lion’s den with no alarms tripped.

options: Test the token's security layer / Ask about the backup plan / Check the ARES schematics location

## 6. Rooftop Noodle Stall (n_0005, model qwen3.6-35b-a3b)

> **Vex** (free): I go in alone and jack straight into the Kagero core, skipping the ice-breaker Rin prepared.

- **Rin**: Wait, what? You’re ditching the ride?
- **Hollow**: Bold. Or reckless. Usually the same thing in your line of work.
- Vex stands, sliding the iridescent token into their jacket pocket. The neon hum of the stall fades into the background as they look toward the Kagero tower’s spire.
- **Vex**: Rin’s ice-breaker takes two minutes. I can cut it in half if I go straight for the core.
- **Rin**: Half? Vex, the core has a recursive logic bomb! You’ll fry your cortex if you don’t have a buffer!
- **Hollow**: But if you succeed, we save precious time. And time is the one thing we don’t have.

options: Jack in immediately / Ask Hollow for a safety net / Tell Rin to stay behind

## 7. Rooftop Noodle Stall (n_0006, model qwen3.6-35b-a3b)

> **Vex** (option): Jack in immediately

- Vex jacks the data line into the port behind their ear. The noodle stall dissolves into a wireframe grid of neon and rain. The Kagero tower’s firewall looms ahead, a towering wall of shifting geometric shapes.
- **Rin**: Hey! You’re not even waiting for my signal! Vex, if you burn out, I’m not carrying your shell back to the stall!
- **Hollow**: The connection is live. The encryption window is holding. You are inside the lobby.
- **Vex**: Pushing past the first ICE layer. It’s… surprisingly light. Almost too light.
- **Rin**: Ghost ID is working. The system thinks we’re Kusanagi. Keep moving, but watch your back.
- **Hollow**: The elevator shaft to the 84th floor is open. But the stairs are guarded. Take the lift.

options: Take the elevator to the 84th floor / Check the lobby for security logs / Call Rin to verify the route

## 8. Rooftop Noodle Stall (n_0007, model nvidia/nemotron-3-ultra-550b-a55b)

> **Vex** (free): The alarms are screaming but I stay plugged in to grab the chip myself instead of retreating.

- The lobby's pristine walls fracture into crimson wireframes. Alarm klaxons scream through the local net, a discordant symphony of flashing geometry and hostile ICE spawning like antibodies around a wound.
- **Vex**: Shutdown sequence ignored. Routing power to decryption suite. I'm not leaving without that chip.
- **Rin**: Vex, your neural readings are spiking! That logic bomb Hollow warned about — it's activating! You're taking direct feedback damage!
- **Hollow**: Fascinating. The ghost ID held long enough to trigger a silent alarm, not a hard lockout. Kagero's ICE is adapting to your signature in real-time.
- Black ICE constructs materialize — jagged, predatory code-sharks circling the vault's digital perimeter. The memory chip's encryption pulses at the center, a beating heart of stolen credits and erased lives.
- **Vex**: Adapt this. I've danced with worse in the old sectors.
- **Rin**: Damn it, Vex! The elevator's moving — Kusanagi's security team is ascending! You've got maybe ninety seconds before physical and digital converge on your position!
- **Hollow**: The chip's encryption key rotates in forty seconds. After that, the data corrupts permanently. Your call, netrunner  "scene_change": false,
- "scene": {"id": "noodle_stall_rooftop", "name": "Rooftop Noodle Stall", "image_prompt": "Neo-Kowloon rooftop at midnight, neon signs reflecting on wet metal surfaces, noodle stall equipment steaming in the rain, Kagero tower spire visible in distance, rain-slicked pavement, moody cyberpunk lighting"},
- "bgm_mood": "action",
- "weather": "rain",
- "options": ["Brute-force the encryption before key rotation", "Deploy a logic bomb to freeze the ICE", "Jack out and flee to the elevator", "Split focus: hack chip while tracing Kusanagi's team"],
- "state_changes": {"affection": {"Rin": -2, "Hollow": 1}, "flags_add": ["alarm_triggered", "logic_bomb_active", "kusanagi_team_inbound", "chip_encryption_rotating"], "items_add": [], "items_remove": []},
- "summary_update": "Vex ignores the alarm and stays jacked in to grab the memory chip. Black ICE activates and Kusanagi's security team ascends the elevator. The chip's encryption key rotates in 40 seconds, after which data corrupts permanently.",
- "ending": null
- }

options: Brute-force the encryption before key rotation / Deploy a logic bomb to freeze the ICE / Jack out and flee to the elevator / Split focus: hack chip while tracing Kusanagi's team

## 9. Rooftop Noodle Stall (n_0008, model nvidia/nemotron-3-ultra-550b-a55b)

> **Vex** (option): Brute-force the encryption before key rotation

- The wireframe lobby shudders as Vex unleashes a raw brute-force cascade, neon digits hammering the memory chip's rotating encryption like a jackhammer on glass. Crimson ICE sharks tear at the connection, their code-teeth scraping firewalls and leaving trails of corrupted data in Vex's visual cortex.
- **Vex**: Come on, you bastard — yield!
- **Rin**: Vex, your synaptic temp is hitting critical! You're bleeding from the nose — physical feedback!
- **Hollow**: Impressive throughput. The encryption is fracturing — three layers down, one rotating key remaining. Twenty seconds.
- The elevator chime echoes through both meat-space and net-space — a soft, cheerful ding that screams arrival. Heavy bootfalls clang on metal grating. Kusanagi's team has breached the 84th floor corridor.
- **Vex**: Ten seconds. I can taste the plaintext.
- **Rin**: They're at the vault door! Vex, jack OUT! I'm spinning the AV up — roof extraction in forty seconds if you MOVE!
- **Hollow**: The chip's data structure is destabilizing. Force the final key rotation and you risk corrupting the very credits you came for. A calculated gamble.

options: Push the final brute-force and risk data corruption / Switch to surgical decryption to preserve the chip / Jack out now and sprint for the roof extraction / Upload a logic bomb to buy time for clean extraction

## 10. AV Extraction (n_0009, model nvidia/nemotron-3-ultra-550b-a55b)

> **Vex** (free): I stop hesitating and risk everything right now to settle this once and for all.

- The wireframe lobby convulses as Vex channels every scrap of processing power into a single, blistering assault on the final encryption layer. Neon code fragments explode outward like shrapnel, the chip's pulsing heart seizing, stuttering — then settling into a clean, static rhythm. The Black ICE sharks dissolve into geometric dust, their adaptive algorithms overwhelmed by raw, unfiltered violence.
- **Vex**: Got it. The chip is mine.
- **Rin**: Vex — your vitals just flatlined for three seconds. Three. Seconds. You crazy bastard, you actually pulled it off.
- **Hollow**: A clean extraction against a rotating military cipher. Impressive. The ARES schematics sit in the adjacent partition, untouched. Our arrangement stands.
- The elevator doors hiss open behind Vex's meat-body on the 84th floor. Armored boots fan out — Kusanagi's elite squad, rifles raised, thermal optics glowing. But the vault's digital lock clicks open, the memory chip's data streaming into Vex's deck in a torrent of recovered credits and erased identities.
- **Vex**: Rin. Roof. Now.
- **Rin**: Already climbing. AV's hot on the pad — thirty seconds to dust-off. Don't you dare die on me after that stunt.
- **Hollow**: I'll handle the physical pursuit. The token's ghost ID still has twelve minutes on its cipher. A parting gift.
- Rain hammers the rooftop as the AV's rotors cut through the neon haze. Vex's vision swims, meat and mesh bleeding together, the chip's weight secure in their deck. The Kagero tower's spire recedes below — a fortress breached, a debt repaid, a corporation's stranglehold on a district's savings shattered in twenty seconds of madness.

**GOOD ENDING: Debt Repaid**

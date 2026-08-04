// The /world page (#160): mounts the vendored Kubeez scroll-world engine
// (site/public/world-assets/v1/scrub-engine.js) into #world. Asset names are pinned
// here so the reveal issue's live test can assert on them; the stills/clips land
// with the media in that issue — this page ships dark and medialess.
import './world.scss';

const mount = document.getElementById('world');
if (!mount) {
  throw new Error('world: #world mount container missing from world.html');
}
if (typeof window.mountScrollWorld !== 'function') {
  // world.html's script order is load-bearing: the classic, blocking engine script
  // must define the global before this deferred module runs.
  throw new Error('world: window.mountScrollWorld missing — scrub-engine.js must load first');
}

// The static copy is the no-JS / crawler fallback; the engine rebuilds every scene
// client-side. Hide it before mounting so the engine's track is the only in-flow
// content and starts at scrollY 0, which the engine's segment math assumes.
document.getElementById('world-static')?.setAttribute('hidden', '');

const ASSETS = '/world-assets/v1';

window.mountScrollWorld(mount, {
  brand: { name: 'developerz.ai Designer', href: '/' },
  nav: true,
  cta: { label: 'Join the waitlist', href: '/#notify' },
  diveScroll: 1.3,
  connScroll: 0.9,
  sections: [
    {
      id: 'page',
      label: 'The Page',
      still: `${ASSETS}/img/01-page.webp`,
      stillAlt: 'A web app open in Chrome with the Designer side panel docked alongside the page.',
      clip: `${ASSETS}/vid/01-page.mp4`,
      clipMobile: `${ASSETS}/vid/01-page-m.mp4`,
      accent: '#4f46e5',
      eyebrow: 'The Page',
      title: 'Any page you own.',
      body: 'Your prod app, a staging build, or localhost.',
    },
    {
      id: 'pick',
      label: 'The Pick',
      still: `${ASSETS}/img/02-pick.webp`,
      stillAlt: 'The Designer element picker highlighting a section of the live page.',
      clip: `${ASSETS}/vid/02-pick.mp4`,
      clipMobile: `${ASSETS}/vid/02-pick-m.mp4`,
      accent: '#4f46e5',
      linger: 0.45,
      eyebrow: 'The Pick',
      title: 'Click anything.',
      body: 'The agent sees exactly what you see.',
    },
    {
      id: 'talk',
      label: 'Talk',
      still: `${ASSETS}/img/03-talk.webp`,
      stillAlt: 'The Designer chat panel with a design change described in plain English.',
      clip: `${ASSETS}/vid/03-talk.mp4`,
      clipMobile: `${ASSETS}/vid/03-talk-m.mp4`,
      accent: '#8b5cf6',
      linger: 0.45,
      eyebrow: 'Talk',
      title: 'Say it in plain English.',
      body: '“Make the hero full-bleed, tighten the nav.”',
    },
    {
      id: 'see',
      label: 'See',
      still: `${ASSETS}/img/04-see.webp`,
      stillAlt: 'The live page mid-edit as the agent mutates its DOM and CSS.',
      clip: `${ASSETS}/vid/04-see.mp4`,
      clipMobile: `${ASSETS}/vid/04-see-m.mp4`,
      accent: '#10b981',
      linger: 0.45,
      eyebrow: 'See',
      title: 'Watch the page change.',
      body: 'It mutates the real DOM and CSS while you react.',
    },
    {
      id: 'ship',
      label: 'Ship',
      still: `${ASSETS}/img/05-ship.webp`,
      stillAlt: 'The recorded changeset in the Designer panel, ready to ship as a pull request.',
      clip: `${ASSETS}/vid/05-ship.mp4`,
      clipMobile: `${ASSETS}/vid/05-ship-m.mp4`,
      accent: '#8b5cf6',
      eyebrow: 'Ship',
      title: 'One click, one real PR.',
      body: 'A changeset goes over MCP; your dev agent edits the source.',
      cta: { primary: { label: 'Join the waitlist', href: '/#notify' } },
    },
  ],
  connectors: [
    `${ASSETS}/vid/conn1.mp4`,
    `${ASSETS}/vid/conn2.mp4`,
    `${ASSETS}/vid/conn3.mp4`,
    `${ASSETS}/vid/conn4.mp4`,
  ],
  connectorsMobile: [
    `${ASSETS}/vid/conn1-m.mp4`,
    `${ASSETS}/vid/conn2-m.mp4`,
    `${ASSETS}/vid/conn3-m.mp4`,
    `${ASSETS}/vid/conn4-m.mp4`,
  ],
});

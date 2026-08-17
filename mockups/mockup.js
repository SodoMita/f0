const ICONS = {
  world: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  spark: '<path d="M12 3v18M3 12h18"/><path d="m5.6 5.6 12.8 12.8M18.4 5.6 5.6 18.4"/>',
  thread: '<circle cx="12" cy="5" r="2.2"/><circle cx="5.5" cy="18.5" r="2.2"/><circle cx="18.5" cy="18.5" r="2.2"/><path d="M12 7.2v4.2M5.5 16.3v-2.2h13v2.2M12 11.4v2.7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  shuffle: '<path d="M4 7h2.5c5.5 0 5.5 10 11 10H20M4 17h2.5c2.4 0 3.7-1.9 4.9-4M14.1 8.8C15.1 7.7 16.1 7 17.5 7H20"/><path d="m17.5 4.5 2.5 2.5-2.5 2.5M17.5 14.5 20 17l-2.5 2.5"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  density: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  prev: '<path d="m15 5-7 7 7 7"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
  play: '<path d="m9 6 9 6-9 6z"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3v10H4z"/><circle cx="12" cy="13" r="3"/>',
  cube: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9"/>',
  reply: '<path d="M10 8 5 12l5 4M5 12h7.5c3.6 0 6.5 2.2 6.5 6"/>',
  download: '<path d="M12 4v11M8 11l4 4 4-4M5 20h14"/>',
  expand: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  heart: '<path d="M20 8.5c0 5-8 10-8 10s-8-5-8-10A4.5 4.5 0 0 1 12 5.7 4.5 4.5 0 0 1 20 8.5z"/>',
  zoomin: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5M10.5 7.5v6M7.5 10.5h6"/>',
  zoomout: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5M7.5 10.5h6"/>',
  fit: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/><circle cx="12" cy="12" r="2.5"/>',
  undo: '<path d="M8 8H4V4M4.5 8A8 8 0 1 1 5 17"/>',
  redo: '<path d="M16 8h4V4M19.5 8A8 8 0 1 0 19 17"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 16v4h14v-4"/>',
  type: '<path d="M5 6V4h14v2M12 4v16M8 20h8"/>',
  brush: '<path d="m14 5 5 5-8 8-5-5zM5 14c-2 1-2 3-1 5 2 1 4 1 5-1"/>',
  shapes: '<circle cx="8" cy="8" r="4"/><path d="m16 4 4 8h-8zM13 15h7v6h-7z"/>',
  light: '<circle cx="12" cy="11" r="4"/><path d="M12 2v2M4.2 4.2l1.5 1.5M19.8 4.2l-1.5 1.5M3 11h2M19 11h2M8.5 16.5 7.5 19h9l-1-2.5"/>',
  publish: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
};

function mountIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((node) => {
    if (node.dataset.iconMounted) return;
    const paths = ICONS[node.dataset.icon];
    if (!paths) return;
    const svg = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
    if (node.classList.contains('icon-only') || node.childElementCount === 0 && !node.textContent.trim()) {
      node.innerHTML = svg;
    } else {
      node.insertAdjacentHTML('afterbegin', svg);
    }
    node.dataset.iconMounted = 'true';
  });
}

mountIcons();

document.querySelectorAll('[data-press]').forEach((button) => {
  button.addEventListener('click', () => {
    const pressed = button.getAttribute('aria-pressed') === 'true';
    button.setAttribute('aria-pressed', String(!pressed));
  });
});

const density = document.querySelector('[data-density]');
density?.addEventListener('click', () => {
  document.body.classList.toggle('compact-world');
  density.setAttribute('aria-pressed', String(document.body.classList.contains('compact-world')));
});

const filters = document.querySelectorAll('[data-filter]');
filters.forEach((filter) => {
  filter.addEventListener('click', () => {
    filters.forEach((item) => item.classList.remove('active'));
    filter.classList.add('active');
    document.querySelector('.world-grid')?.animate(
      [{ opacity: 0.4, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' }
    );
  });
});

const viewerImage = document.querySelector('[data-viewer-image]');
if (viewerImage) {
  const scenes = [
    { src: './assets/orbit-bloom.jpg', index: '07', code: 'ORBIT/BLOOM', theme: 'paper' },
    { src: './assets/blue-stack.jpg', index: '08', code: 'STACK/BLUE', theme: 'paper' },
    { src: './assets/glass-signal.jpg', index: '09', code: 'SIGNAL/GLASS', theme: 'night' }
  ];
  let sceneIndex = 0;
  const updateViewer = (direction = 1) => {
    sceneIndex = (sceneIndex + direction + scenes.length) % scenes.length;
    const scene = scenes[sceneIndex];
    viewerImage.classList.add('changing');
    setTimeout(() => {
      viewerImage.src = scene.src;
      viewerImage.alt = `${scene.code} digital sculpture`;
      document.querySelectorAll('[data-object-index]').forEach((el) => { el.textContent = scene.index; });
      document.querySelectorAll('[data-object-code]').forEach((el) => { el.textContent = scene.code; });
      document.body.dataset.scene = scene.theme;
      viewerImage.classList.remove('changing');
    }, 150);
  };
  document.querySelector('[data-viewer-next]')?.addEventListener('click', () => updateViewer(1));
  document.querySelector('[data-viewer-prev]')?.addEventListener('click', () => updateViewer(-1));

  const play = document.querySelector('[data-viewer-play]');
  play?.addEventListener('click', () => {
    const playing = play.getAttribute('aria-pressed') !== 'true';
    play.setAttribute('aria-pressed', String(playing));
    play.dataset.icon = playing ? 'pause' : 'play';
    play.innerHTML = '';
    delete play.dataset.iconMounted;
    mountIcons(play.parentElement || document);
    viewerImage.classList.toggle('is-playing', playing);
  });

  document.querySelectorAll('[data-camera]').forEach((camera) => {
    camera.addEventListener('click', () => {
      document.querySelectorAll('[data-camera]').forEach((item) => item.classList.remove('active'));
      camera.classList.add('active');
      document.querySelector('.viewer-object-wrap')?.style.setProperty('--camera-shift', camera.dataset.camera || '0');
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') updateViewer(1);
    if (event.key === 'ArrowLeft') updateViewer(-1);
    if (event.key.toLowerCase() === 'a') play?.click();
  });
}

const infoToggles = document.querySelectorAll('[data-info-toggle]');
infoToggles.forEach((toggle) => {
  toggle.addEventListener('click', () => {
    document.body.classList.toggle('show-object-info');
    const expanded = document.body.classList.contains('show-object-info');
    infoToggles.forEach((item) => item.setAttribute('aria-pressed', String(expanded)));
  });
});

const threadGraph = document.querySelector('[data-thread-graph]');
if (threadGraph) {
  let zoom = 1;
  const setZoom = (value) => {
    zoom = Math.max(0.65, Math.min(1.35, value));
    threadGraph.style.setProperty('--thread-zoom', String(zoom));
    const output = document.querySelector('[data-zoom-output]');
    if (output) output.textContent = `${Math.round(zoom * 100)}%`;
  };
  document.querySelector('[data-zoom-in]')?.addEventListener('click', () => setZoom(zoom + 0.1));
  document.querySelector('[data-zoom-out]')?.addEventListener('click', () => setZoom(zoom - 0.1));
  document.querySelector('[data-zoom-fit]')?.addEventListener('click', () => setZoom(0.85));
  document.addEventListener('keydown', (event) => {
    if (event.key === '+' || event.key === '=') setZoom(zoom + 0.1);
    if (event.key === '-') setZoom(zoom - 0.1);
    if (event.key === '0') setZoom(0.85);
  });
}

document.querySelectorAll('[data-studio-tool]').forEach((tool) => {
  tool.addEventListener('click', () => {
    document.querySelectorAll('[data-studio-tool]').forEach((item) => item.classList.remove('active'));
    tool.classList.add('active');
    const name = tool.getAttribute('aria-label') || 'tool';
    const label = document.querySelector('[data-tool-label]');
    if (label) label.textContent = name;
  });
});

document.querySelectorAll('[data-inspector-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    const id = tab.dataset.inspectorTab;
    document.querySelectorAll('[data-inspector-tab]').forEach((item) => item.classList.toggle('active', item === tab));
    document.querySelectorAll('[data-inspector-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.inspectorPanel !== id;
    });
  });
});

const stageObject = document.querySelector('[data-stage-object]');
document.querySelectorAll('[data-object-control]').forEach((control) => {
  const applyControl = () => {
    if (!stageObject) return;
    const value = control.value;
    if (control.dataset.objectControl === 'rotate') stageObject.style.setProperty('--object-rotate', `${value}deg`);
    if (control.dataset.objectControl === 'scale') stageObject.style.setProperty('--object-scale', value);
    if (control.dataset.objectControl === 'light') stageObject.style.setProperty('--object-light', value);
    const output = control.closest('.control-row')?.querySelector('output');
    if (output) output.value = control.dataset.suffix ? `${value}${control.dataset.suffix}` : value;
  };
  control.addEventListener('input', applyControl);
  applyControl();
});

const publish = document.querySelector('[data-publish]');
publish?.addEventListener('click', () => {
  publish.classList.add('published');
  publish.dataset.icon = 'check';
  publish.innerHTML = '<span>ready</span>';
  delete publish.dataset.iconMounted;
  mountIcons(publish.parentElement || document);
  setTimeout(() => {
    publish.classList.remove('published');
    publish.dataset.icon = 'publish';
    publish.innerHTML = '<span>release</span>';
    delete publish.dataset.iconMounted;
    mountIcons(publish.parentElement || document);
  }, 1800);
});

if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.querySelectorAll('[data-tilt]').forEach((surface) => {
    surface.addEventListener('pointermove', (event) => {
      const rect = surface.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      surface.style.setProperty('--tilt-x', `${x * 7}px`);
      surface.style.setProperty('--tilt-y', `${y * 7}px`);
    });
    surface.addEventListener('pointerleave', () => {
      surface.style.setProperty('--tilt-x', '0px');
      surface.style.setProperty('--tilt-y', '0px');
    });
  });
}

(function () {
  const CDNJS = 'https://cdnjs.cloudflare.com/ajax/libs/';
  const JSDELIVR = 'https://cdn.jsdelivr.net/npm/';
  const libs = [
    {
      ready: () => window.React,
      urls: [
        CDNJS + 'react/18.3.1/umd/react.production.min.js',
        JSDELIVR + 'react@18.3.1/umd/react.production.min.js',
        '/vendor/react.production.min.js',
      ],
    },
    {
      ready: () => window.ReactDOM,
      urls: [
        CDNJS + 'react-dom/18.3.1/umd/react-dom.production.min.js',
        JSDELIVR + 'react-dom@18.3.1/umd/react-dom.production.min.js',
        '/vendor/react-dom.production.min.js',
      ],
    },
    {
      ready: () => window.Chart,
      urls: [
        CDNJS + 'Chart.js/4.4.1/chart.umd.min.js',
        JSDELIVR + 'chart.js@4.4.1/dist/chart.umd.js',
        '/vendor/chart.umd.js',
      ],
    },
  ];

  function load(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = resolve;
      script.onerror = () => {
        script.remove();
        reject(new Error(url));
      };
      document.head.appendChild(script);
    });
  }

  async function loadLib(lib) {
    for (const url of lib.urls) {
      try {
        await load(url);
        if (lib.ready()) return;
      } catch {
        continue;
      }
    }
    throw new Error('library unavailable');
  }

  function showFailure() {
    const root = document.getElementById('root');
    const box = document.createElement('div');
    box.className = 'banner lost';
    box.setAttribute('role', 'alert');
    box.textContent = 'Не удалось загрузить библиотеки интерфейса. Проверьте доступ к cdnjs.cloudflare.com или cdn.jsdelivr.net, либо положите файлы в public/vendor (см. README).';
    root.appendChild(box);
  }

  (async () => {
    try {
      for (const lib of libs) await loadLib(lib);
      await load('/app.js');
    } catch {
      showFailure();
    }
  })();
})();

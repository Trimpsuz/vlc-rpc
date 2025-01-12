document.getElementById('connect-button').addEventListener('click', async (e) => {
  e.preventDefault();

  const config = {
    ip: document.getElementById('ip').value || 'localhost',
    port: parseInt(document.getElementById('port').value) || 8080,
    password: document.getElementById('password').value,
  };

  const username = document.getElementById('username').value;
  if (username) {
    config.username = username;
  }

  const reply = await backend.saveConfig(config);

  if (reply === 'connected') {
    M.toast({ html: 'Connected successfully!' });
  } else {
    M.toast({ html: reply });
  }
});

document.addEventListener('DOMContentLoaded', async function () {
  const savedConfig = await backend.loadConfig();
  if (savedConfig) {
    document.getElementById('ip').value = savedConfig.ip || 'localhost';
    document.getElementById('port').value = savedConfig.port || '8080';
    document.getElementById('username').value = savedConfig.username || '';
    document.getElementById('password').value = savedConfig.password || '';
  } else {
    document.getElementById('ip').value = 'localhost';
    document.getElementById('port').value = '8080';
  }

  M.updateTextFields();
});

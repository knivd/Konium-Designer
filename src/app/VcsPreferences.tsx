/**
 * Preferences › Data Management › Version Control, below the settings: the teams whose keys are
 * in this browser (Konium's store: a new team, one joined with its key, a key copied to send to a
 * colleague, a team forgotten here), and the sign-ins kept for teams' own Git servers. Both are
 * kept in this browser only, apart from the settings, and change at once (not on OK).
 */
import { useState } from 'preact/hooks';
import { notify } from './state';
import { forgetTeam, keepTeam, logins, newTeam, setLogin, teams, vcsTick } from './vcs';

export function VcsPreferences() {
  void vcsTick.value;
  const list = teams(), signins = Object.entries(logins());
  const [name, setName] = useState(''), [key, setKey] = useState(''), [err, setErr] = useState('');
  const [host, setHost] = useState(''), [user, setUser] = useState(''), [tok, setTok] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  return (
    <div class="vcd-prefs">
      <h4>Teams (Konium's store)</h4>
      <p class="small muted">A team's projects are sealed with its key before they leave this browser; konium.app never has the key. Send it only to people who should have the team's projects (whoever has it can open them), and keep a copy: a key lost can't be got back.</p>
      {list.length ? (
        <table class="sd-table" aria-label="Teams"><thead><tr><th>Team</th><th>Key</th><th /></tr></thead>
          <tbody>{list.map((t) => (
            <tr key={t.id}><td>{t.name}</td><td class="vcd-key">{shown === t.id ? t.key : `${t.key.slice(0, 9)}…`}</td>
              <td class="vcd-acts">
                <button class="btn" onClick={() => setShown(shown === t.id ? null : t.id)}>{shown === t.id ? 'Hide' : 'Show'}</button>
                <button class="btn" onClick={() => { void navigator.clipboard?.writeText(t.key); notify(`${t.name}'s key copied`); }}>Copy Key</button>
                <button class="btn" title="This browser forgets the key; the team's projects stay in the store" onClick={() => forgetTeam(t.id)}>Forget Here</button>
              </td></tr>
          ))}</tbody></table>
      ) : <p class="small">No teams here yet.</p>}
      <div class="vcd-row">
        <input aria-label="Team name" placeholder="Team's name (only you see it)" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <button class="btn" onClick={() => void newTeam(name || 'My team').then(() => { setName(''); setErr(''); })}>New Team</button>
      </div>
      <div class="vcd-row">
        <input aria-label="Team key to join" placeholder="KON1-… (a key a colleague sent)" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
        <button class="btn" onClick={() => void keepTeam(name || 'Team', key).then(() => { setKey(''); setName(''); setErr(''); }).catch((e) => setErr((e as Error).message))}>Join a Team</button>
      </div>
      {err && <p class="small ai-error">{err}</p>}

      <h4>Sign-ins for teams' own Git servers</h4>
      <p class="small muted">For GitHub, GitLab and others: your user name and a personal access token (with read and write to the repository's contents), kept in this browser only and sent only to that server (through Konium's relay, which passes it on and keeps nothing, unless the relay is switched off above).</p>
      {signins.length ? (
        <table class="sd-table" aria-label="Git sign-ins"><thead><tr><th>Server</th><th>User</th><th /></tr></thead>
          <tbody>{signins.map(([h, l]) => <tr key={h}><td>{h}</td><td>{l.username}</td><td class="vcd-acts"><button class="btn" onClick={() => setLogin(h, null)}>Forget</button></td></tr>)}</tbody></table>
      ) : <p class="small">None kept.</p>}
      <div class="vcd-row">
        <input aria-label="Server" placeholder="github.com" value={host} onInput={(e) => setHost((e.target as HTMLInputElement).value.trim())} />
        <input aria-label="User name" placeholder="User name" value={user} onInput={(e) => setUser((e.target as HTMLInputElement).value)} />
        <input aria-label="Access token" type="password" placeholder="Access token" value={tok} onInput={(e) => setTok((e.target as HTMLInputElement).value)} />
        <button class="btn" disabled={!host || !user || !tok} onClick={() => { setLogin(host.replace(/^https?:\/\//, '').replace(/\/.*$/, ''), { username: user, password: tok }); setHost(''); setUser(''); setTok(''); }}>Keep</button>
      </div>
    </div>
  );
}

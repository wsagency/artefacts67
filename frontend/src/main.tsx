import { Errored, onSettled, Show } from 'solid-js';
import { render } from '@solidjs/web';
import type { JSX } from '@solidjs/web';
import { ConsoleShell } from './shell';
import { AuthScreen } from './auth';
import { AppHome, AppNew, AppFolderNew, FolderPane, ArtefactPane } from './estate';
import { Settings, Keys, AdminHome, Users, PlatformSettings, Reports } from './settings';
import { ArtifactViewer } from './viewer';
import { Feedback } from './ui';
import { page, consoleIdentity, navigationError, installNavigation } from './navigation';
import type { PageProps } from './types';
import './styles.css';

const screens: Record<string, (props: { p: PageProps }) => JSX.Element> = { appHome: AppHome, appNew: AppNew, appFolderNew: AppFolderNew, folderPane: FolderPane, artefactPane: ArtefactPane, settings: Settings, keys: Keys, adminHome: AdminHome, users: Users, platformSettings: PlatformSettings, reports: Reports };
function ConsoleContent() {
  // Fresh form defaults and one-time credentials belong to screen content, not the shell.
  // The reader remains unkeyed so incidental responses leave its iframe alive.
  return <Show when={page().screen === 'artefactReader'} fallback={<Show when={page()} keyed>{current => {
    const Screen = screens[current.screen];
    return Screen ? <Screen p={current.props} /> : <div innerHTML={current.props.main ?? ''} />;
  }}</Show>}><ArtifactViewer viewer={page().props.viewer ?? null} /></Show>;
}
function OrdinaryPage() {
  return <Show when={page()} keyed>{current => <AuthScreen screen={current.screen} p={current.props} />}</Show>;
}
function App() {
  onSettled(() => installNavigation());
  return <Errored fallback={error => <main class="fatal-error"><h1>The console could not be displayed</h1><p>{String(error())}</p><a href="/app">Return to artefacts</a></main>}><Feedback error={navigationError()} /><Show when={consoleIdentity(page())} keyed fallback={<Show when={page().screen === 'artifactViewer'} fallback={<OrdinaryPage />}><ArtifactViewer viewer={page().props.viewer ?? null} title={page().props.title} /></Show>}>{_identity => <ConsoleShell p={page().props} screen={page().screen}><ConsoleContent /></ConsoleShell>}</Show></Errored>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Artefacts67 root is missing.');
render(() => <App />, root);

import { Check, Choice, PostForm } from './ui';
import { shouldShowContentReadCheck } from './key-capability';

export interface KeyCreationFormProps {
  csrf: string;
  kind: string;
  onKindChange: (kind: string) => void;
  hasMaster: boolean;
  artifacts: Array<{ id: string; slug?: string }>;
}

export function KeyCreationForm(props: KeyCreationFormProps) {
  return <PostForm action="/settings/keys/mint" csrf={props.csrf} submit="Create key">
    <Choice name="kind" label="Kind" value={props.kind} onChange={props.onKindChange}
      options={[['artifact', 'Artefact key'], ...(!props.hasMaster ? [['master', 'Master key'] as [string, string]] : [])]} />
    {shouldShowContentReadCheck(props.kind, props.hasMaster) && <Check name="can_read_content">Allow this key to read content</Check>}
    {props.hasMaster && <p class="muted">A master key already exists. Rotate it rather than creating another.</p>}
    <Choice name="artifactId" label="Artefact (for an artefact key)" options={props.artifacts.map(artifact => [artifact.id, artifact.slug || artifact.id])} />
    {!props.artifacts.length && <p class="muted">Publish an artefact before creating an artefact key.</p>}
    <Choice name="scopes" label="Scope (for an artefact key)" options={[
      ['read', 'Read'], ['write', 'Write'], ['read_write', 'Read and write'],
    ]} />
  </PostForm>;
}

/** Read-only public ONS smoke: never loads credentials, calls inference, or writes a database. */
import { OnsAdapter } from '../server/services/businessData';
async function main() {
  const adapter = new OnsAdapter(20);
  const catalogue = await adapter.listDatasets();
  if (!Array.isArray(catalogue.items)) throw new Error('ONS catalogue did not return items');
  const relevant = catalogue.items.filter((x: any) => /price|business|employment|earning|productivity/i.test(`${x.title} ${x.description}`));
  console.log(JSON.stringify({ catalogueItems: catalogue.items.length, totalCount: catalogue.total_count,
    selected: relevant.slice(0, 3).map((x: any) => ({ id: x.id, title: x.title, current: x.current?.id })) }));
  const item = relevant.find((x: any) => x.id === 'cpih01') || relevant[0];
  if (!item?.id) throw new Error('No supported economic dataset found');
  const dataset = await adapter.getDataset(item.id);
  const link = dataset.links?.latest_version?.href;
  const match = typeof link === 'string' && /\/editions\/([^/]+)\/versions\/(\d+)$/.exec(link);
  if (!match) throw new Error('Dataset has no supported latest-version link');
  const [, edition, version] = match;
  const metadata = await adapter.getVersion(item.id, edition, version);
  const dimensions: Record<string, string> = {};
  for (const dim of metadata.dimensions || []) {
    const options = await adapter.getDimensionOptions(item.id, edition, version, dim.name);
    if (!Array.isArray(options.items) || !options.items.length) throw new Error(`No options for ${dim.name}`);
    dimensions[dim.name] = dim.name === 'time' ? options.items[0].label :
      (dim.name === 'geography' ? options.items.find((x: any) => x.option === 'K02000001') : null)?.option || options.items[0].option;
  }
  const evidence = await adapter.getObservation({ datasetId: item.id, edition, version, dimensions });
  const raw = evidence.raw as any;
  console.log(JSON.stringify({ datasetId: item.id, edition, version, dimensions, url: evidence.url,
    observationCount: raw.observations?.length, observations: raw.observations, unit: raw.unit_of_measure }));
  if (!raw.observations?.some((x: any) => Number.isFinite(Number(x.observation)) && String(x.observation).trim())) throw new Error('HTTP 200 contained no usable observations');
  console.log('PASS public ONS catalogue → metadata → dimension options → actual observation. No opportunity, LLM, queue or production claim.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

import StoreExplorer from "./components/StoreExplorer";
import packageMetadata from "../package.json";

export default function Home() {
  return <StoreExplorer version={packageMetadata.version} />;
}

import { useState } from "react";
import FirecrawlComponent from "./components/ingestion";
import FirecrawlComponentV1 from "./components/ingestionV1";
import MonitorsComponent from "./components/monitors";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

function App() {
  const [selectedComponent, setSelectedComponent] = useState<"v0" | "v1" | "monitors">("v1");

  return (
    <>
      <div className="flex justify-center items-center space-x-2 p-4">
        <RadioGroup
          defaultValue="v1"
          onValueChange={(value) => setSelectedComponent(value as "v0" | "v1" | "monitors")}
          className="flex space-x-6 mt-6"
        >
          <div className="flex items-center space-x-2 p-2">
            <RadioGroupItem value="v0" id="v0"></RadioGroupItem>
            <Label htmlFor="v0">Firecrawl Component V0</Label>
          </div>
          <div className="flex items-center space-x-2 p-2">
            <RadioGroupItem value="v1" id="v1"></RadioGroupItem>
            <Label htmlFor="v1">Firecrawl Component V1</Label>
          </div>
          <div className="flex items-center space-x-2 p-2">
            <RadioGroupItem value="monitors" id="monitors"></RadioGroupItem>
            <Label htmlFor="monitors">Monitors</Label>
          </div>
        </RadioGroup>
      </div>
      {selectedComponent === "v1" ? (
        <FirecrawlComponentV1 />
      ) : selectedComponent === "monitors" ? (
        <MonitorsComponent />
      ) : (
        <FirecrawlComponent />
      )}
    </>
  );
}

export default App;

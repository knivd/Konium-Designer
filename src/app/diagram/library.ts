/**
 * The Shapes panel's libraries: General, Misc, Advanced and Electrical shapes in the diagram format's own
 * styles and sizes (so files stay readable by other editors of the format), searchable by name and tags.
 */
import type { P, Rect } from '../../formats/drawio';
import { ELECTRICAL } from './electrical';

export interface Entry {
  title: string;
  /** More words the search finds it by. */
  tags?: string;
  style: string;
  w: number;
  h: number;
  value?: string;
  /** A connector: its ends and waypoints in its w × h box. */
  edge?: { from: P; to: P; points?: P[] };
  /** Cells inside it (a list's items), in its frame. */
  kids?: { style: string; rect: Rect; value: string }[];
  /** A block linked to this schematic sheet (the Project Sheets library). */
  sheet?: string;
}
export interface Library { id: string; title: string; entries: Entry[] }

const v = (title: string, style: string, w: number, h: number, value = '', tags = ''): Entry => ({ title, style, w, h, value, tags });
/** A connector drawn from the bottom left of its box to the top right (as the format's libraries make them). */
const e = (title: string, style: string, w: number, h: number, tags = '', points?: P[]): Entry => ({ title, style, w, h, tags, edge: { from: { x: 0, y: h }, to: { x: w, y: 0 }, ...(points ? { points } : {}) } });

const ITEM = 'text;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;spacingLeft=4;spacingRight=4;overflow=hidden;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;rotatable=0;whiteSpace=wrap;html=1;';

export const LIBRARIES: Library[] = [
  {
    id: 'general', title: 'General', entries: [
      v('Rectangle', 'rounded=0;whiteSpace=wrap;html=1;', 120, 60, '', 'rect box'),
      v('Rounded Rectangle', 'rounded=1;whiteSpace=wrap;html=1;', 120, 60, '', 'rect box round'),
      v('Text', 'text;html=1;align=center;verticalAlign=middle;resizable=0;points=[];autosize=1;strokeColor=none;fillColor=none;', 60, 30, 'Text', 'label'),
      v('Textbox', 'text;html=1;whiteSpace=wrap;overflow=hidden;rounded=0;', 180, 120, '<h1 style="margin-top: 0px;">Heading</h1><p>Text</p>', 'heading paragraph'),
      v('Ellipse', 'ellipse;whiteSpace=wrap;html=1;', 120, 80, '', 'oval'),
      v('Square', 'whiteSpace=wrap;html=1;aspect=fixed;', 80, 80, '', 'box'),
      v('Circle', 'ellipse;whiteSpace=wrap;html=1;aspect=fixed;', 80, 80, '', 'round'),
      v('Process', 'shape=process;whiteSpace=wrap;html=1;backgroundOutline=1;', 120, 60, '', 'flowchart subroutine'),
      v('Diamond', 'rhombus;whiteSpace=wrap;html=1;', 80, 80, '', 'decision rhombus flowchart'),
      v('Parallelogram', 'shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;', 120, 60, '', 'data input output'),
      v('Hexagon', 'shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;fixedSize=1;', 120, 80, '', 'preparation'),
      v('Triangle', 'triangle;whiteSpace=wrap;html=1;', 60, 80, '', 'arrow'),
      v('Cylinder', 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;', 60, 80, '', 'database storage'),
      v('Cloud', 'ellipse;shape=cloud;whiteSpace=wrap;html=1;', 120, 80, '', 'network internet'),
      v('Document', 'shape=document;whiteSpace=wrap;html=1;boundedLbl=1;', 120, 80, '', 'paper flowchart'),
      v('Internal Storage', 'shape=internalStorage;whiteSpace=wrap;html=1;backgroundOutline=1;', 80, 80, '', 'memory'),
      v('Cube', 'shape=cube;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;darkOpacity=0.05;darkOpacity2=0.1;', 120, 80, '', 'box 3d'),
      v('Step', 'shape=step;perimeter=stepPerimeter;whiteSpace=wrap;html=1;fixedSize=1;', 120, 80, '', 'chevron arrow'),
      v('Trapezoid', 'shape=trapezoid;perimeter=trapezoidPerimeter;whiteSpace=wrap;html=1;fixedSize=1;', 120, 60, '', 'manual operation'),
      v('Tape', 'shape=tape;whiteSpace=wrap;html=1;', 120, 100, '', 'flag'),
      v('Note', 'shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;darkOpacity=0.05;', 80, 100, '', 'page comment'),
      v('Card', 'shape=card;whiteSpace=wrap;html=1;', 80, 100, '', 'punched card'),
      v('Callout', 'shape=callout;whiteSpace=wrap;html=1;perimeter=calloutPerimeter;', 120, 80, '', 'speech bubble comment'),
      v('Actor', 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;', 30, 60, 'Actor', 'person user stick figure'),
      v('Or', 'shape=xor;whiteSpace=wrap;html=1;', 60, 80, '', 'logic gate'),
      v('And', 'shape=or;whiteSpace=wrap;html=1;', 60, 80, '', 'logic gate'),
      v('Data Storage', 'shape=dataStorage;whiteSpace=wrap;html=1;fixedSize=1;', 100, 80, '', 'stored data'),
      v('Container', 'swimlane;startSize=0;', 200, 200, '', 'group frame'),
      v('Vertical Container', 'swimlane;whiteSpace=wrap;html=1;', 200, 200, 'Vertical Container', 'group pool lane swimlane'),
      v('Horizontal Container', 'swimlane;horizontal=0;whiteSpace=wrap;html=1;', 200, 200, 'Horizontal Container', 'group pool lane swimlane'),
      { title: 'List', tags: 'table entity', style: 'swimlane;fontStyle=0;childLayout=stackLayout;horizontal=1;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;whiteSpace=wrap;html=1;', w: 140, h: 120, value: 'List',
        kids: [1, 2, 3].map((i) => ({ style: ITEM, rect: { x: 0, y: 30 * i, w: 140, h: 30 }, value: `Item ${i}` })) },
      v('List Item', ITEM, 80, 30, 'Item', 'row'),
      e('Curve', 'curved=1;endArrow=classic;html=1;', 50, 50, 'connector', [{ x: 50, y: 50 }, { x: 0, y: 0 }]),
      e('Bidirectional Arrow', 'shape=flexArrow;endArrow=classic;startArrow=classic;html=1;', 100, 100, 'flex'),
      e('Arrow', 'shape=flexArrow;endArrow=classic;html=1;', 50, 50, 'flex'),
      e('Dashed Line', 'endArrow=none;dashed=1;html=1;', 50, 50, 'connector'),
      e('Dotted Line', 'endArrow=none;dashed=1;html=1;dashPattern=1 3;strokeWidth=2;', 50, 50, 'connector'),
      e('Line', 'endArrow=none;html=1;', 50, 50, 'connector'),
      e('Bidirectional Connector', 'endArrow=classic;startArrow=classic;html=1;', 50, 50, 'arrow'),
      e('Directional Connector', 'endArrow=classic;html=1;', 50, 50, 'arrow'),
      { title: 'Link', tags: 'connector double line', style: 'shape=link;html=1;', w: 100, h: 0, edge: { from: { x: 0, y: 0 }, to: { x: 100, y: 0 } } },
    ],
  },
  {
    id: 'misc', title: 'Misc', entries: [
      v('Title', 'text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=24;fontStyle=1;', 120, 40, 'Title', 'heading text'),
      v('Horizontal Line', 'line;strokeWidth=2;html=1;', 160, 10, '', 'separator rule'),
      v('Vertical Line', 'line;strokeWidth=2;direction=south;html=1;', 10, 160, '', 'separator rule'),
      v('Double Ellipse', 'ellipse;shape=doubleEllipse;whiteSpace=wrap;html=1;', 100, 60, '', 'oval end state'),
      v('Rounded Square', 'rounded=1;whiteSpace=wrap;html=1;aspect=fixed;', 80, 80, '', 'box'),
      v('Container (Rounded)', 'swimlane;rounded=1;whiteSpace=wrap;html=1;', 200, 200, 'Container', 'group frame'),
      v('Label Box', 'whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;fontColor=#333333;', 120, 60, 'Label', 'grey'),
      v('Highlight', 'rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;', 120, 60, '', 'yellow note'),
    ],
  },
  {
    id: 'advanced', title: 'Advanced', entries: [
      v('Manual Input', 'shape=manualInput;whiteSpace=wrap;html=1;', 80, 80, '', 'flowchart'),
      v('Loop Limit', 'shape=loopLimit;whiteSpace=wrap;html=1;', 100, 80, '', 'flowchart'),
      v('Off-page Connector', 'shape=offPageConnector;whiteSpace=wrap;html=1;', 80, 80, '', 'flowchart'),
      v('Delay', 'shape=delay;whiteSpace=wrap;html=1;', 80, 40, '', 'flowchart'),
      v('Display', 'shape=display;whiteSpace=wrap;html=1;', 80, 40, '', 'flowchart'),
      v('Arrow Right', 'shape=singleArrow;whiteSpace=wrap;html=1;', 100, 60, '', 'block arrow'),
      v('Arrow Left', 'shape=singleArrow;direction=west;whiteSpace=wrap;html=1;', 100, 60, '', 'block arrow'),
      v('Arrow Up', 'shape=singleArrow;direction=north;whiteSpace=wrap;html=1;', 60, 100, '', 'block arrow'),
      v('Arrow Down', 'shape=singleArrow;direction=south;whiteSpace=wrap;html=1;', 60, 100, '', 'block arrow'),
      v('Double Arrow', 'shape=doubleArrow;whiteSpace=wrap;html=1;', 100, 60, '', 'block arrow'),
      v('Double Arrow Vertical', 'shape=doubleArrow;direction=south;whiteSpace=wrap;html=1;', 60, 100, '', 'block arrow'),
      v('Cross', 'shape=cross;whiteSpace=wrap;html=1;', 80, 80, '', 'plus'),
      v('Corner', 'shape=corner;whiteSpace=wrap;html=1;', 80, 80, '', 'l shape'),
      v('Tee', 'shape=tee;whiteSpace=wrap;html=1;', 80, 80, '', 't shape'),
      v('Triangle Down', 'triangle;direction=south;whiteSpace=wrap;html=1;', 80, 60, '', 'merge'),
      v('Triangle Up', 'triangle;direction=north;whiteSpace=wrap;html=1;', 80, 60, '', 'extract'),
    ],
  },
  { id: 'electrical', title: 'Electrical', entries: ELECTRICAL },
];

/** The entries a search finds: every word in the title or tags. */
export function searchLibraries(q: string, libs: Library[] = LIBRARIES): Entry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const l of libs) for (const x of l.entries) {
    const hay = `${x.title} ${x.tags ?? ''} ${l.title}`.toLowerCase();
    if (words.every((w) => hay.includes(w)) && !seen.has(x.title + x.style)) { seen.add(x.title + x.style); out.push(x); }
  }
  return out;
}

/** A schematic sheet as a block linked to it (the Project Sheets library). */
export const SHEET_STYLE = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;';
export const sheetEntry = (sheet: string): Entry => ({ title: sheet, style: SHEET_STYLE, w: 140, h: 60, value: sheet.replace(/\.schdoc$/i, ''), sheet, tags: 'sheet schematic' });

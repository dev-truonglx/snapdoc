/** Annotation ảnh (dán/kéo thả) trong `AnnotationStage`. */
import { useEffect, useState } from "react";
import { Group, Image as KImage } from "react-konva";
import type Konva from "konva";
import { useEditor } from "../store";
import { imageAnnCache } from "./imageCache";
import { SelectionFrame } from "./selectionShapes";

export interface ImageItemProps {
  ann: import("../model").ImageAnn;
  draggable: boolean;
  isSelected: boolean;
  activeIds: string[];
  onSelect: (multi: boolean) => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformEnd: (node: Konva.Node) => void;
}

export function ImageItem({ ann, draggable, isSelected, activeIds, onSelect, onDragEnd, onTransformEnd }: ImageItemProps) {
  const [loadedImg, setLoadedImg] = useState<HTMLImageElement | null>(() => imageAnnCache.get(ann.src) ?? null);

  useEffect(() => {
    if (imageAnnCache.has(ann.src)) {
      setLoadedImg(imageAnnCache.get(ann.src)!);
      return;
    }
    let cancelled = false;
    const el = new window.Image();
    el.crossOrigin = "anonymous";
    const onDone = () => {
      imageAnnCache.set(ann.src, el);
      if (!cancelled) setLoadedImg(el);
    };
    if (typeof el.decode === "function") {
      el.src = ann.src;
      el.decode().then(onDone).catch(() => {
        el.onload = onDone;
        el.onerror = () => console.error("Không thể load ảnh ann:", ann.id);
        el.src = ann.src;
      });
    } else {
      el.onload = onDone;
      el.onerror = () => console.error("Không thể load ảnh ann:", ann.id);
      el.src = ann.src;
    }
    return () => {
      cancelled = true;
      el.onload = null;
      el.onerror = null;
    };
  }, [ann.src, ann.id]);

  useEffect(() => {
    if (loadedImg && isSelected) {
      useEditor.getState().select(ann.id);
    }
  }, [loadedImg, isSelected, ann.id]);

  if (!loadedImg) return null;

  return (
    <Group key={ann.id}>
      <KImage
        id={ann.id}
        image={loadedImg}
        x={ann.x}
        y={ann.y}
        width={ann.width}
        height={ann.height}
        shadowColor={isSelected ? "#3b82f6" : undefined}
        shadowBlur={isSelected ? 6 : 0}
        shadowOpacity={isSelected ? 0.9 : 0}
        draggable={draggable}
        listening={draggable}
        onClick={(e) => onSelect(Boolean(e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey))}
        onTap={() => onSelect(false)}
        onDragEnd={onDragEnd}
        onTransformEnd={(e) => onTransformEnd(e.target)}
      />
      {isSelected && activeIds.length > 1 && (
        <SelectionFrame x={ann.x} y={ann.y} width={ann.width} height={ann.height} />
      )}
    </Group>
  );
}

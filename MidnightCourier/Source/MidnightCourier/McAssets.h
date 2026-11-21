#pragma once

#include "CoreMinimal.h"

class UStaticMesh;
class UMaterialInterface;
class UMaterialInstanceDynamic;
class USoundBase;

/** Looks up content by short name (cached). Meshes live in /Game/Courier/Meshes, materials in
 *  /Game/Courier/Materials, sounds in /Game/Courier/Audio. "Cube", "Cylinder", "Sphere", "Plane" give the
 *  engine's basic shapes. Missing assets return null so the game still runs before the art is built. */
namespace McAssets
{
	UStaticMesh* Mesh(const TCHAR* Name);
	class USkeletalMesh* SkeletalMesh(const TCHAR* Name);
	UMaterialInterface* Material(const TCHAR* Name);
	USoundBase* Sound(const TCHAR* Name);
	UMaterialInstanceDynamic* Tinted(UObject* Outer, const FLinearColor& Color, float Emissive = 0.f);
}

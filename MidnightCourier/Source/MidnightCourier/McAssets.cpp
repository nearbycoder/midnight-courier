#include "McAssets.h"

#include "Engine/StaticMesh.h"
#include "Engine/SkeletalMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "Sound/SoundBase.h"
#include "UObject/UObjectGlobals.h"

namespace
{
	template <typename T>
	T* LoadCached(TMap<FString, TWeakObjectPtr<T>>& Cache, const FString& Path)
	{
		if (TWeakObjectPtr<T>* Found = Cache.Find(Path))
		{
			if (Found->IsValid()) { return Found->Get(); }
			if (!Found->IsValid() && Found->IsExplicitlyNull()) { return nullptr; }
		}
		T* Obj = nullptr;
		if (FPackageName::DoesPackageExist(FPackageName::ObjectPathToPackageName(Path)))
		{
			Obj = LoadObject<T>(nullptr, *Path, nullptr, LOAD_NoWarn | LOAD_Quiet);
		}
		if (Obj) { Obj->AddToRoot(); }
		Cache.Add(Path, Obj);
		return Obj;
	}

	FString AssetPath(const TCHAR* Folder, const TCHAR* Name)
	{
		return FString::Printf(TEXT("/Game/Courier/%s/%s.%s"), Folder, Name, Name);
	}
}

UStaticMesh* McAssets::Mesh(const TCHAR* Name)
{
	static TMap<FString, TWeakObjectPtr<UStaticMesh>> Cache;
	const FString N(Name);
	if (N == TEXT("Cube") || N == TEXT("Cylinder") || N == TEXT("Sphere") || N == TEXT("Plane") || N == TEXT("Cone"))
	{
		return LoadCached(Cache, FString::Printf(TEXT("/Engine/BasicShapes/%s.%s"), Name, Name));
	}
	return LoadCached(Cache, AssetPath(TEXT("Meshes"), Name));
}

USkeletalMesh* McAssets::SkeletalMesh(const TCHAR* Name)
{
	static TMap<FString, TWeakObjectPtr<USkeletalMesh>> Cache;
	return LoadCached(Cache, AssetPath(TEXT("Meshes"), Name));
}

UMaterialInterface* McAssets::Material(const TCHAR* Name)
{
	static TMap<FString, TWeakObjectPtr<UMaterialInterface>> Cache;
	return LoadCached(Cache, AssetPath(TEXT("Materials"), Name));
}

USoundBase* McAssets::Sound(const TCHAR* Name)
{
	static TMap<FString, TWeakObjectPtr<USoundBase>> Cache;
	return LoadCached(Cache, AssetPath(TEXT("Audio"), Name));
}

UMaterialInstanceDynamic* McAssets::Tinted(UObject* Outer, const FLinearColor& Color, float Emissive)
{
	static TMap<FString, TWeakObjectPtr<UMaterialInterface>> Cache;
	UMaterialInterface* Base = Material(TEXT("M_Tint"));
	if (!Base) { Base = LoadCached(Cache, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial")); }
	UMaterialInstanceDynamic* MID = UMaterialInstanceDynamic::Create(Base, Outer);
	MID->SetVectorParameterValue(TEXT("Color"), Color);
	MID->SetScalarParameterValue(TEXT("Emissive"), Emissive);
	return MID;
}

from rest_framework import viewsets
from .models import Image
from .serializers import ImageSerializer

class ImageViewSet(viewsets.ModelViewSet):
    queryset = Image.objects.all().order_by('-created_at')
    serializer_class = ImageSerializer

    def get_queryset(self):
        user_id = self.request.query_params.get('user_id')
        if user_id:
            return self.queryset.filter(user_id=user_id)
        return self.queryset
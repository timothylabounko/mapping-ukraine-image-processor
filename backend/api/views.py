from rest_framework import viewsets, status
from rest_framework.decorators import api_view
from rest_framework.response import Response
from .models import User, Image
from .serializers import UserSerializer, ImageSerializer

# ----- CUSTOM LOGIN VIEW -----
@api_view(['POST'])
def login(request):
    email = request.data.get('email')  # <-- use email, not username
    password = request.data.get('password')

    if not email or not password:
        return Response({'error': 'Email and password required'}, status=status.HTTP_400_BAD_REQUEST)

    try:
        user = User.objects.get(email=email)  # <-- match your model
    except User.DoesNotExist:
        return Response({'error': 'Invalid credentials'}, status=status.HTTP_401_UNAUTHORIZED)

    if user.password != password:  # <- only plain-text check for now
        return Response({'error': 'Invalid credentials'}, status=status.HTTP_401_UNAUTHORIZED)

    return Response({
        'user_id': user.user_id,
        'email': user.email,        # <- return email instead of username
        'phone_number': user.phone_number
    })

# ----- USER VIEWSET -----
class UserViewSet(viewsets.ModelViewSet):
    queryset = User.objects.all()
    serializer_class = UserSerializer


# ----- IMAGE VIEWSET -----
class ImageViewSet(viewsets.ModelViewSet):
    queryset = Image.objects.all()
    serializer_class = ImageSerializer

    def get_queryset(self):
        user_id = self.request.query_params.get('user_id')
        if user_id:
            try:
                user_id_int = int(user_id)
                return self.queryset.filter(user__user_id=user_id_int)
            except ValueError:
                return self.queryset.none()
        return self.queryset